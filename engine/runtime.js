// Film runtime: boots WebGPU and the layer host, then renders frames on request from a render worker
// (tools/worker.mjs: renders, and the NLE's live viewer).
//
// A film is { duration, layers, scene(t) → { camera, bg, nodes, post }, cuts? }. scene(t) must be a pure function
// of t. Each frame: seek(t) updates the DOM of the layers (film clock), live and invalidated layers are captured,
// then the scene is evaluated at every motion-blur sub-frame time and accumulated.
import { seek, pin, rest } from './time.js';
import { createHost, Layer, captureLayers, imagesReady } from './layers.js';
import { Renderer } from './render/index.js';
import { filterOffset, PIXEL_FILTER } from './render/filter.js';
import { axes } from './render/scene.js';
import { W, H, setFrame, screenShift, basis, project, asOrbit, CHANNELS } from './camera.js';
import { Mesh, EMPTY } from './mesh.js';
import { pickAt, rayAt, outline, corners, siteOf, fieldsOf, matchCopy } from './pick.js';
import { here, liveEdits } from './site.js';
import { thingNodes } from './things.js';
import { applyOverrides, applyCamera, applyScene, findPlaced, codeValue, cameraValue, sceneValue, nudged, nudgedCamera, CAMERA, SCENE, SCENE_NUMBERS } from './overrides.js';
import { setOverrides, atMoment, STACKS } from './motion.js';
import { between } from './between.js';
import { frozen } from './frozen.js';
import { partsRead } from './score.js';
import { loadGLTF } from './gltf.js';
import { Light, lightNumbers, lightWay } from './light.js';
import { Pass, Texture, Target, editable } from './pass.js';
import { Surface, everySurface } from './surface.js';
import { watchCompiling } from './render/compiling.js';
import { hasRays } from './render/rays.js';

/**
 * The timeline this page plays, for a film's cues and music: `timelines/<id>.json` beside the film's code (`base`, its
 * import.meta.url), the id from the page's ?timeline= (`main` by default). A project's timelines (sequences: a
 * cut-down, a version to other music) share its code, layers and media, and one film plays whichever it is given:
 *   const TL = await timeline(import.meta.url);
 * Its `size` ([w, h] px; 1920 × 1080 if it has none) is the film's frame: W and H (camera.js) are it from here on, so
 * code after this line lays out for it.
 */
export async function timeline(base) {
  const id = new URLSearchParams(location.search).get('timeline') || 'main';
  const r = await fetch(new URL(`timelines/${encodeURIComponent(id)}.json`, base), { cache: 'no-store' });
  if (!r.ok) throw new Error(`no timeline "${id}" (timelines/${id}.json beside the film)`);
  loaded = await r.json();
  setFrame(loaded.size);
  setOverrides(loaded.overrides);   // (those that change the code's motions apply where they are evaluated)
  return loaded;
}
let loaded = null;   // the timeline the film read (its overrides apply over the film's scene: see overrides.js)

export function createFilm() {
  const host = createHost();
  const layers = [], cursors = [], cueRefs = new Map(), loads = [], passes = [];
  return {
    host,
    cursors,
    // the cues the film reads (elements/cues.js), id → { found: whether the timeline has it, whole: whether it read more
    // of it than its time and length }
    cueRefs,
    /** Registers a DOM layer (see layers.js for the conventions). */
    layer(content, o) { const L = new Layer(host, content, o); L.site = here(); layers.push(L); return L; },
    /** A mesh from geometry (see mesh.js: box, sphere, sweep, arch, frame, torus…), placed in scene(t) with .at() or .many(). */
    mesh(geo, o) { const M = new Mesh(geo, o); M.site = here(); return M; },
    /** One of the scene's own lights, 'point' or 'spot' (see light.js), placed in scene(t) with .at(). */
    light(type, o) { const L = new Light(type, o); L.site = here(); return L; },
    /** A mesh's look in the film's own WGSL (see surface.js), given to a mesh where it is placed: .at(x, y, z, { surface }). */
    surface(code, o) { return new Surface(code, o); },
    /** A picture its passes read (see pass.js: an image, beside the page, loaded before ready(); or its own numbers). */
    texture(source, o) { const T = new Texture(source, o); if (T.url) loads.push(T.load(location.href)); return T; },
    /** A picture its passes draw into (a pass's target) and others read: the frame's size × scale, or its own. */
    target(o) { return new Target(o); },
    /** A full-screen shader of the film's own (see pass.js): fog, a grade, grain, a raymarched world; placed with .at(). */
    pass(code, o) { const P = new Pass(code, o); P.site = here(); passes.push(P); return P; },
    /** A glTF model (.gltf or .glb, relative to the page) as a mesh, its largest side `size` px; loaded before ready(). */
    model(url, { size, ...o } = {}) {
      const M = new Mesh(EMPTY, o);
      M.site = here();   // (where the film made it: the editor's code panel)
      loads.push(loadGLTF(url, { size }).then((r) => M.set({ ...r, material: { ...r.material, ...o.material } })));
      return M;
    },
    /** Starts the runtime once the film is described. */
    run(film) {
      return boot(host, layers, film, cursors, cueRefs, loads, passes).catch((e) => {
        window.__bootError = String(e?.stack || e);
        // (the editor's own film, nle/viewport.js, told why it will not start)
        // (the editor's own film, nle/viewport.js, told why it will not start: its page in the viewport's render process
        // posts to itself, which its preload passes on, app/viewport-preload.cjs)
        const vp = new URLSearchParams(location.search).get('viewport');
        if (vp && (parent !== window || vp === 'worker')) parent.postMessage({ ephemeris: 'viewport-failed', error: window.__bootError.slice(0, 2000) }, '*');
        const msg = document.createElement('pre');
        Object.assign(msg.style, { position: 'fixed', inset: '0', margin: '0', padding: '24px', zIndex: '20', background: '#200', color: '#fcc', font: '14px ui-monospace, monospace', whiteSpace: 'pre-wrap' });
        msg.textContent = `film failed to start\n\n${window.__bootError}`;
        document.body.append(msg);
        throw e;
      });
    },
  };
}

async function boot(host, layers, film, cursors, cueRefs, loads, passes) {
  // headless Chrome can report no adapter for a moment after load
  let adapter = null;
  for (let i = 0; i < 100 && !adapter; i++) { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) await new Promise((r) => setTimeout(r, 50)); }
  if (!adapter) throw new Error('no WebGPU adapter');
  // the largest buffers the adapter allows: layers' fragments (order-independent transparency) live in one
  const { maxTextureDimension2D, maxStorageBufferBindingSize, maxBufferSize } = adapter.limits;
  // (and room in the mesh pass for what it keeps for the denoiser: 80 bytes a pixel, where the default is 32; see DN_KEEP)
  const maxColorAttachmentBytesPerSample = Math.min(adapter.limits.maxColorAttachmentBytesPerSample, 128);
  // (and as many textures and storage buffers a shader may read as the adapter has: the renderer's scene and a film's
  // passes' pictures share them)
  const { maxSampledTexturesPerShaderStage, maxStorageBuffersPerShaderStage } = adapter.limits;
  // (and the GPU's timestamps, where it has them: the studio's profiler, render/profile.js; Metal's, read on an M1, ran
  // past the frame's own time, so not on Apple's GPUs)
  const timed = adapter.features.has('timestamp-query') && adapter.info?.vendor !== 'apple';
  const dev = await adapter.requestDevice({ requiredFeatures: [...(timed ? ['timestamp-query'] : []), ...(adapter.features.has('acceleration-structure') ? ['acceleration-structure'] : [])], requiredLimits: { maxTextureDimension2D, maxStorageBufferBindingSize, maxBufferSize, maxColorAttachmentBytesPerSample, maxSampledTexturesPerShaderStage, maxStorageBuffersPerShaderStage } });
  const compiling = watchCompiling(dev);
  // the timeline's own visuals (its visual tracks' clips: images, videos), each a layer of its own (see timelineClips)
  const clips = timelineClips(host, layers, loaded);
  host.fit();
  // (the page's scale changes as its window moves to another display, the film in the editor's frame: each layer zoomed
  // to keep its res, and captured again)
  const watchScale = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { for (const L of layers) L.rescale(); host.fit(); watchScale(); }, { once: true });
  watchScale();
  // a GPU error (out of memory, say) leaves the frames after it stale or black, so the next frame fails the render
  let gpuError = null;
  const gpuFailed = (m) => { console.error('[gpu]', m); gpuError ??= m; };
  dev.addEventListener('uncapturederror', (e) => gpuFailed(e.error?.message ?? String(e)));
  // HTML-in-Canvas needs the host canvas to own a rendering context
  host.canvas.getContext('webgpu').configure({ device: dev, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
  // global illumination, traced shadows and reflections for the whole film where its timeline sets them: ?gi=,
  // ?shadows=, ?reflections= (1 on, 0 off); how they are traced, over what its scenes ask (?rendering=, the timeline's
  // rendering as JSON); and the film's own renderer, where it has one (its render: its passes, its shaders' parts)
  const page = new URLSearchParams(location.search), all = (k) => (page.has(k) ? page.get(k) === '1' : null);
  const rendering = page.has('rendering') ? JSON.parse(page.get('rendering')) : {};
  const comp = new Renderer(dev, { gi: all('gi'), shadows: all('shadows'), reflections: all('reflections'), rendering, render: film.render, surfaces: everySurface });
  // the pixel filter's width and type where the timeline sets them: ?pixelFilter= (px), ?pixelFilterType= (render/filter.js)
  const pixelFilter = page.has('pixelFilter') ? +page.get('pixelFilter') : PIXEL_FILTER, pixelFilterType = page.get('pixelFilterType');
  await document.fonts.ready;
  await imagesReady(host);
  await Promise.all(loads);
  // what the film measures as it gets ready sees its CSS animations at rest, however long the boot took
  rest();
  await film.ready?.();
  // the DOM as a frame at t captures it: the clock, the film's own changes, and any animation those start
  const domAt = (t) => { seek(t); film.update?.(t); pin(t); return clipFrames(clips, t); };   // (a video clip's frame: loaded)
  // (and brought there only once the GPU has done what it was given: a layer's canvas the GPU still reads, captured, waits
  // for it when the film's code draws on it again, the page's thread held meanwhile, where the canvases are drawn by
  // another API than WebGPU's, as in the editor's window under Wayland: seconds, the frames before still being drawn)
  const domAtFree = async (t) => { await dev.queue.onSubmittedWorkDone(); return domAt(t); };
  // the scene at t: motions placed as values take its moment (and those it makes are numbered as each time: atMoment)
  const scene0 = film.scene.bind(film);
  // (each time it runs, counted, and the moment it last ran at: what it paints as it runs, a screen's canvas, is as it
  // left it, which a frame drawn later needs to know: see drawSub)
  let runs = 0, ranAt = 0;
  const sceneOnly = (t) => { try { return comp.prof.time('Film code', () => atMoment(t, () => scene0(t))); } finally { runs++; ranAt = t; } };
  // pointer targets measured from the DOM are measured now, each at its own moment, not when a frame first needs them
  for (const c of cursors) c.measure?.(domAt);
  const cuts = [...(film.cuts ?? [])].sort((a, b) => a - b);
  // sub-frames never straddle a hard cut: they stay on their frame's side of it
  const clampToShot = (tf, ts) => { for (const c of cuts) { if (ts < c && tf >= c) return c; if (ts >= c && tf < c) return c - 1e-4; } return ts; };

  // the editor's overrides, over what the film's code places (each node then carries where it was placed)
  // (a draft — the editor trying a change before it is saved, or while it is dragged — stands in for them for one
  // request: see drafted; and the timeline's changes, edited, are taken in without loading the film again: __overrides)
  // (and the things the director added, which come with them: { thing: its clip }; engine/things.js)
  let saved = liveEdits(loaded);
  let overrides = saved;
  const addedIn = (list) => list.filter((o) => o?.thing).map((o) => ({ clip: o.thing, end: o.thing.at + (o.thing.out - o.thing.in) }));
  let added = addedIn(overrides);
  if (overrides.length) globalThis.__sites = true;
  const draft = (list) => { overrides = list ?? saved; added = addedIn(overrides); setOverrides(overrides); if (overrides.length) globalThis.__sites = true; placed?.clear(); };
  // the code's scene at t, with the timeline's clips and added things there (a clip where it was placed: placeClip; a
  // linked copy of what the code places needs the code's nodes to say where they were placed)
  film.scene = (t) => {
    const linked = added.some((a) => a.clip.thing.of), was = globalThis.__sites;
    if (linked) globalThis.__sites = true;
    let s;
    try { s = sceneOnly(t); } finally { if (linked) globalThis.__sites = was; }
    const on = clips.filter((k) => k.c.at <= t && t < k.end), things = added.filter((a) => a.clip.at <= t && t < a.end);
    if (!on.length && !things.length) return s;
    return { ...s, nodes: [...s.nodes, ...on.map((k) => clipNode(k, placeClip(k))), ...things.flatMap((a) => thingNodes(a.clip, s.nodes, matchCopy))] };
  };
  // (an Aim lane over a value the code computes is sized against the code's scene at another moment)
  // (s: the code's scene at t, where it is already found)
  // (nudge: a gesture in the editor's viewport as it goes, over the changes: viewport.js, overrides.js nudged)
  let nudge = null;
  const sceneAt = (t, s = film.scene(t)) => {
    s.t ??= t;
    const r = overrides.length ? applyScene({ ...s, nodes: applyOverrides(s.nodes, overrides, t, film.scene), camera: cameraOf(s.camera, t) }, overrides, t, film.scene) : s;
    if (!nudge) return r;
    return { ...r, nodes: nudge.refs.length ? nudged(r.nodes, nudge.refs, nudge.vals, nudge.v0) : r.nodes, ...(nudge.camera && { camera: nudgedCamera(r.camera, nudge.vals, nudge.v0) }) };
  };
  // the film's camera at t, with the editor's changes to it
  const cameraOf = (c, t) => applyCamera(c, overrides, t, (tt) => film.scene(tt).camera);
  const cameraAt = (t) => cameraOf(film.scene(t).camera, t);
  // where a clip sits: under the film's camera where it starts (as the editor has the camera), facing it, filling its
  // frame there (covering it: the picture's longer way past the frame's edge); worked out once for its version
  const placed = new Map();
  const placeClip = (k) => {
    let p = placed.get(k.c.id);
    if (!p) {
      const cam = cameraOf(sceneOnly(k.c.at).camera, k.c.at), B = basis(cam), deg = (r) => (r * 180) / Math.PI;
      const fw = W / (cam.zoom ?? 1), fh = H / (cam.zoom ?? 1), w = k.m.w / k.m.h > fw / fh ? (fh * k.m.w) / k.m.h : fw;
      p = { x: B.center[0], y: B.center[1], z: B.center[2], rx: deg(Math.atan2(B.down[2], B.back[2])), ry: deg(Math.asin(-B.right[2])), rz: deg(Math.atan2(B.right[1], B.right[0])), s: w / k.m.w };
      placed.set(k.c.id, p);
    }
    return p;
  };
  // view: another camera than the film's (the editor's director's view, orbiting outside it): one sample at t, without
  // what belongs to the film's camera (screen-space nodes, post)
  const fromView = (s, view) => ({ ...s, camera: view, nodes: s.nodes.filter((n) => n && !n.screen) });
  // the time the director's view last drew, and in which look: moving its camera there again needs no DOM or captures
  let viewAt = null, viewLook = null;
  // the film's code at the moment last drawn or looked at, with the overrides then (known): a frame there, or what goes
  // over one, runs it again only for another moment or other overrides, or once layers are captured (a node of a layer
  // holds its picture as the code made it). (sites: made with every call site taken, which finding things needs) A frame
  // drawn takes it only while the code has not run since (drawn: what it paints, as it ran last, is the moment's own)
  let known = null;
  const knownAt = (t, sites = false, drawn = false) => (known && known.t === t && known.list === overrides && (known.sites || !sites) && (!drawn || known.runs === runs) ? known.code : null);
  const know = (t, code, sites = globalThis.__sites === true) => { known = code ? { t, list: overrides, code, sites, runs } : null; };
  const capture = (need, t) => { captureLayers(dev, comp, need, t); known = null; };
  // playing in the director's view: the page catching up to a newer time, in the background, at most ~12 times a second
  // (capturing a film's animated layers takes the page's thread: a product film's six live layers, ~40 ms)
  let catching = null, caughtAt = -1e9;
  // a frame drawn on past its own sub-frames, as the editor's viewer converges on a paused frame (render's going on: F,
  // and how many of its sub-frames are drawn); nothing else drawn since
  let going = null;
  // look: how the studio's preview draws it (the renderer's LOOKS); other than 'accurate', in one sub-frame, without
  // motion blur or depth of field (Solid and Wire without the post too)
  // (scale: of the frame's size, as drawn: a preview the size of the editor's viewer, fewer pixels to draw; see resize)
  // (show(pixels, done, sub): a frame shown while it is drawn, its sub-frames spread (see drawSub), the frame so far given
  // after its first and then about ten times a second; prepare: the frame made ready to draw (F), not drawn; cap: the
  // most sub-frames a fast camera raises it to)
  // (present: a canvas of the page's own, where the frame is drawn, nothing read back: the editor's own viewer; frame: a
  // view's own, [w, h] px about its camera's centre, the film's unless given)
  // (said: told each stage of the frame as it starts, in words for the director: the editor's own film's viewer)
  async function render(t, sub = 8, shutter = 0.5, fps = 60, view = null, live = false, look = 'accurate', scale = 1, { show = null, prepare = false, cap = 64, present = null, frame = null, said = null } = {}) {
    going = null;
    comp.look = look;
    comp.resize(scale, view && frame ? frame : [W, H]);
    // the film's code runs once for each moment this call asks about more than once: the frame's own (its shutter and
    // lens, its layers, a single-sample look's one sub-frame, its post) and the shutter's ends (its layers, its camera);
    // of more than 3 sub-frames, those three are real and the rest virtual, found between them (between.js).
    // Kept for this call only: a draft of the editor's in the next can change what the code gives (its motions)
    const code = new Map(), codeAt = (ts) => { let s = code.get(ts); if (!s) code.set(ts, (s = frozen(film.scene(ts)))); return s; };
    if (knownAt(t, false, true)) code.set(t, knownAt(t));
    const whole = (ts) => sceneAt(ts, code.get(ts) ?? film.scene(ts));
    const quick = look !== 'accurate', drawn = quick ? (ts) => { const s = whole(ts); return { ...s, camera: { ...s.camera, dof: null } }; } : whole;
    if (quick) { sub = 1; shutter = 0; }
    if (view && t === viewAt && look === viewLook && !prepare) { know(t, codeAt(t)); await comp.renderSub(fromView(drawn(t), view), 1, true, [0, 0]); return comp.finish({}, 0, present); }
    if (view && live) {
      // playing in the director's view: what moves (the scene at t, the camera) draws now, the layers as last captured;
      // the page is brought to t and captured meanwhile (a layer never seen before is waited for, rather than missing)
      viewAt = null;
      const layers = [...new Set(codeAt(t).nodes.filter((n) => n?.layer instanceof Layer).map((n) => n.layer))];
      if (!catching && performance.now() - caughtAt > 80) catching = (async () => {
        caughtAt = performance.now();
        await domAtFree(t);
        const need = layers.filter((L) => L.needsCapture(t));
        if (need.length) { for (const L of need) L.hold(t); await host.nextPaint(); capture(need, t); }
      })().finally(() => { catching = null; });
      if (layers.some((L) => !L.gpu)) await catching;
      await comp.renderSub(fromView(drawn(t), view), 1, true, [0, 0]);
      return comp.finish({}, 0, present);
    }
    if (catching) await catching;   // the page is the director's view's until its catching up is done
    viewAt = view ? t : null; viewLook = look;
    const fi = Math.round(t * fps);   // AA jitter seeds from the frame index, so any worker renders a frame identically
    comp.frameInfo = { frame: fi, fps };   // (what the film's passes see as film.frame, film.fps)
    await dev.queue.onSubmittedWorkDone();
    said?.("updating the film's page");
    const paging = performance.now();
    await domAt(t);
    comp.prof.add('Layers', paging);
    // a scene may open the shutter wider for a frame (a swish smears like a real whip pan): never narrower than the film's
    if (!code.has(t)) said?.("running the film's code");
    const sc = codeAt(t);
    shutter = view ? 0 : Math.max(shutter, sc.shutter ?? 0);
    // depth of field is the average over many points on the lens: enough sub-frames for a smooth blur
    if (sc.camera?.dof?.aperture && !quick) sub = Math.max(sub, sc.camera.dof.samples ?? 32);
    const half = shutter / fps / 2;
    const ends = [clampToShot(t, t - half), clampToShot(t, t + half)];
    // only what this frame draws is captured (at its centre and across its shutter): a worker rendering one stretch of
    // the film never uploads the other stretches' layers, which keeps parallel workers inside GPU memory
    const used = new Set();
    for (const ts of [t, ...ends]) for (const n of codeAt(ts).nodes) if (n?.layer instanceof Layer) used.add(n.layer);
    const need = [...used].filter((L) => L.needsCapture(t));
    if (need.length) said?.('capturing its layers');
    if (need.length) { const capturing = performance.now(); comp.prof.at('layers'); for (const L of need) L.hold(t); await host.nextPaint(); capture(need, t); comp.prof.add('Layers', capturing); code.clear(); }   // (a layer's node takes its texture as the code runs: those made before its first capture have none)
    said?.('drawing');
    if (view && !prepare) { await comp.renderSub(fromView(drawn(t), view), 1, true, [0, 0]); know(t, code.get(t)); return comp.finish({}, 0, present); }
    // a fast camera (a swish) gets more sub-frames, about one per 8 px of on-screen travel, so its blur is a smooth
    // streak rather than a row of copies
    if (sub > 1) {
      const camAt = (ts) => cameraOf(codeAt(ts).camera, ts);
      sub = Math.min(cap, Math.max(sub, Math.ceil(screenShift(camAt(ends[0]), camAt(ends[1])) / 8)));
    }
    comp.prof.subs(sub);
    for (const ts of [t, ...ends]) if (sub > 3) codeAt(ts);
    const virtual = sub > 3 ? between(whole(ends[0]), whole(t), whole(ends[1]), ends[0], t, ends[1]) : null;
    const scenes = virtual ?? drawn;
    const F = { t, sub, shutter, fps, fi, sceneAt: view ? (ts) => fromView(scenes(ts), view) : scenes, view: !!view, look, order: show || prepare ? spread(sub) : null, runs, at: ranAt };
    if (prepare) { if (code.has(t)) know(t, code.get(t)); code.clear(); return F; }
    let shown = performance.now();
    for (let i = 0; i < sub; i++) {
      await drawSub(F, i);
      if (!show || i + 1 === sub) continue;
      await dev.queue.onSubmittedWorkDone();   // (paced by the GPU, not by how fast its work is sent)
      if (i === 0 || performance.now() - shown > 100) { await show(await comp.finish(finishOf(F), sub / (i + 1), present), i + 1, sub); shown = performance.now(); }
    }
    return comp.finish(finishOf(F), 0, present);
  }
  // the i-th sub-frame of frame F (render's): the i-th of its shutter, or of its order (F.order: one whose every start
  // spreads over its shutter, its lens and its pixel, so a frame shown before all are drawn shows all of its blur)
  function drawSub(F, i) {
    const { t, sub, shutter, fps, fi, sceneAt } = F, k = F.order ? F.order[i] : i;
    const ts = sub > 1 ? clampToShot(t, t + ((k + 0.5) / sub - 0.5) * (shutter / fps)) : t;
    // (each sub-frame a sample of the pixel filter's: offset as it spreads them)
    const j = sub > 1 ? [filterOffset(halton(k + 1 + fi * 64, 2), pixelFilter, pixelFilterType), filterOffset(halton(k + 1 + fi * 64, 3), pixelFilter, pixelFilterType)] : [0, 0];
    // What the film's code paints as it runs (a screen's canvas: spring-brutalist's scanner) is read as a sub-frame is
    // drawn, and must be as the frame's own code left it. A sub-frame that runs the code is its own moment's. One blended
    // from the frame's moments (between.js), drawn after the code ran for another moment meanwhile (a question about the
    // film, in the gaps, or a cached frame's outlines), keeps the pictures its frame's sub-frames before it took, whatever
    // they show now (held); where another frame's were taken since, or none yet, the frame's code runs again at its moment.
    const ran = runs, s = sceneAt(ts);
    let held = false;
    if (runs !== ran) { F.runs = runs; F.at = ranAt; }
    else if (F.runs !== runs) {
      if (F.fills === comp.textures.fills) held = true;
      else { sceneOnly(F.at); F.runs = runs; }
    }
    return comp.renderSub(held ? { ...s, held } : s, 1 / sub, i === 0, j, sub > 1 ? disk(halton(k + 1 + fi * 64, 5), halton(k + 1 + fi * 64, 7)) : [0, 0], (k + 0.5) / sub)
      .then(() => { F.fills = comp.textures.fills; });
  }
  const finishOf = (F) => (F.view || F.look === 'solid' || F.look === 'wire' ? {} : finishing(F.sceneAt(F.t), F.t));
  // n sub-frames in van der Corput's order (by the bits of each reversed): 0, n/2, n/4, 3n/4…, every start spread over them
  const spread = (n) => {
    const r = (k) => { let x = 0; for (let f = 0.5; k; k >>= 1, f /= 2) if (k & 1) x += f; return x; };
    return [...Array(n).keys()].sort((a, b) => r(a) - r(b));
  };
  // the scene's post, with its frame passes (pass nodes of stage 'frame', in scene order) and the frame's moment
  const finishing = (s, t) => ({ post: s.post, view: s.view, passes: s.nodes.filter((n) => n?.pass && n.pass.stage !== 'scene'), t });

  const params = new URLSearchParams(location.search);
  // the tools' socket (?ws=: tools/worker.mjs), reached through the render page's IPC (app/frames-preload.cjs); a studio
  // older than that, whose pages have no IPC, has the page open the socket itself
  let ws = null;
  if (params.get('ws') && window.__frames) {
    await window.__frames.open(Number(params.get('ws')));
    ws = window.__frames;
  } else if (params.get('ws')) {
    ws = new WebSocket(`ws://127.0.0.1:${params.get('ws')}`);
    ws.binaryType = 'arraybuffer';
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  }
  // (a port for frames drawn now for the studio's window, where the page has one: see sent)
  let memory = null;
  if (ws && window.__frames?.share) memory = await new Promise((r) => { addEventListener('message', function got(e) { if (e.data === 'frames-port') { removeEventListener('message', got); r(e.ports[0]); } }); window.__frames.share(); });
  // (what its shaders are doing: the viewer shows it, tools/worker.mjs)
  if (ws) compiling.to((c) => ws.send(JSON.stringify({ compiling: c })));
  // What the director is waiting on goes first: a frame, a pick, where things are (urgently: marked below). A long question
  // about the film (its objects, its lanes, the camera's path) cannot be stopped as it runs, so it runs in the gaps
  // (inGaps): it looks up every SLICE_MS, between moments of the film, and waits while anything urgent goes on or has
  // just gone on, so that while a camera moves (the next frame already on its way) it stays out of the way altogether.
  // Of several, the newest goes on: what was asked last is what the director is waiting on. Each moment's run of the
  // film's code is shared by every question whose next moment it is (each takes its moments in its own order), so the
  // film's objects and the camera's lanes, asked together at the same frames, sweep the film once, not twice; and the
  // film's idle work (warming up, pre-rendering) waits while any question is out (afterQuestions: it carries on).
  // (each(t, i, s): the question's i-th moment, t, and the film's scene there; sites: what the question has the film's
  // code capture, that moment on: as it was again for anything else)
  const SLICE_MS = 24, QUIET_MS = 120;
  let urgent = 0, urgentAt = -Infinity;
  const asking = [];   // ({ times, next, sites, each, resolve, reject }: the newest last)
  let sweeping = false, afterQuestions = null;
  const urgently = (fn) => async (...args) => { urgent++; try { return await fn(...args); } finally { urgent--; urgentAt = performance.now(); } };
  const inGaps = (times, sites, each) => (times.length ? new Promise((resolve, reject) => { asking.push({ times, next: 0, sites, each, resolve, reject }); if (!sweeping) sweep(); }) : Promise.resolve());
  const behind = () => urgent || performance.now() - urgentAt < QUIET_MS;
  async function sweep() {
    sweeping = true;
    try {
      let from = performance.now();
      while (asking.length) {
        if (behind() || performance.now() - from > SLICE_MS) {
          await new Promise((r) => setTimeout(r));
          while (behind()) await new Promise((r) => setTimeout(r, 10));
          from = performance.now();
          continue;   // (another may be the newest now)
        }
        const lead = asking.at(-1), t = lead.times[lead.next], those = asking.filter((q) => q.times[q.next] === t);
        // (what the code captures: all where one of them needs it all, else the lines any of them needs)
        let sites;
        for (const q of those) { if (q.sites === true) { sites = true; break; } if (q.sites instanceof Set) sites = sites ? new Set([...sites, ...q.sites]) : q.sites; }
        const was = globalThis.__sites;
        if (sites !== undefined) globalThis.__sites = sites;
        try {
          let s, failed = null;
          try { s = film.scene(t); } catch (e) { failed = e; }
          for (const q of those) {
            const done = () => asking.splice(asking.indexOf(q), 1);
            try { if (failed) throw failed; q.each(t, q.next++, s); } catch (e) { done(); q.reject(e); continue; }
            if (q.next >= q.times.length) { done(); q.resolve(); }
          }
        } finally { globalThis.__sites = was; }
      }
    } finally { sweeping = false; afterQuestions?.(); }
  }
  window.__ephemeris = { dev, comp, layers, film, cursors, domAt, lib: { screenShift, basis, project, axes } };   // for the tools
  window.__duration = film.duration;
  window.__size = [W, H];   // (the film's frame: what a render encodes)
  window.__audio = film.audio ? new URL(film.audio, location.href).href : null;
  window.__cuts = cuts;
  window.__cueRefs = [...cueRefs].map(([id, { found, whole }]) => ({ id, found, ...(whole && { whole }) }));
  window.__shaders = await shaderSet(adapter, dev, film, passes);
  window.__partRefs = [...partsRead].map((id) => ({ id, found: !!loaded?.media?.[id] }));   // (the parts whose notes it reads: score.js hits)
  // The frame at t, sent over the tools' socket (or kept in window.__last); returns its size, [w, h]. Raw RGBA (to keep:
  // the viewer's cache keeps it as a PNG, a render encodes it), or for a frame the editor shows once, drawn now: in
  // memory (inMemory, where the page has the port: the studio's own window reads it, app/framefile.cjs), or a JPEG
  // (jpeg: its quality, 0–1: a viewer elsewhere). Encoded synchronously on a CPU canvas: ~3 ms at half size, where
  // toBlob/convertToBlob wait about a second in headless Chrome before encoding.
  // (scale: drawn at that much of the frame's size, as a preview the size of the editor's viewer is; overrides, for the
  // editor's viewer drawing an edit before its frames have rendered: see __director)
  let jpegCanvas = null;
  const toJpeg = (px, quality) => {
    jpegCanvas ??= document.createElement('canvas');
    if (jpegCanvas.width !== comp.pw || jpegCanvas.height !== comp.ph) { jpegCanvas.width = comp.pw; jpegCanvas.height = comp.ph; }
    jpegCanvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), comp.pw, comp.ph), 0, 0);
    const b64 = jpegCanvas.toDataURL('image/jpeg', quality).split(',')[1];
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };
  // a frame shown while it is drawn: the frame so far (and how many of its sub-frames), as a JPEG before it, the frame
  // whole coming last as it always does
  const sentSoFar = (px, done, sub) => {
    if (comp.take) { if (px) memory.postMessage(px); memory.postMessage({ done, sub, w: comp.pw, h: comp.ph }); }
    else if (ws) { ws.send(JSON.stringify({ done, sub, w: comp.pw, h: comp.ph })); ws.send(toJpeg(px, 0.8)); }
  };
  // A frame the GPU refused comes back like any other, black or part drawn, and uncapturederror only says so after it. So
  // it is asked before the frame goes anywhere: the scopes' answers come once all the frame's work has been through the GPU.
  async function unrefused(draw) {
    dev.pushErrorScope('out-of-memory'); dev.pushErrorScope('validation');
    // (memory first: what it refused also makes all that uses it invalid, and the studio makes room only for a full GPU)
    const asked = async () => { const invalid = await dev.popErrorScope(), full = await dev.popErrorScope(); if (full ?? invalid) gpuFailed((full ?? invalid).message); };
    let px;
    try { px = await draw(); } catch (e) { await asked(); throw e; }
    await asked();
    if (gpuError) throw new Error(`GPU error: ${gpuError}`);
    return px;
  }
  // (profile: and what drawing it took, its third: render/profile.js)
  async function sent(draw, jpeg, profile, inMemory = false) {
    if (profile) comp.prof.begin();
    comp.take = inMemory && memory ? (rows) => memory.postMessage(rows) : null;
    try {
      let px = await unrefused(draw);
      if (comp.take && px) memory.postMessage(px);   // (rows the GPU's buffer pads: finish made its own copy)
      else if (!comp.take && jpeg) px = comp.prof.time('Encode', () => toJpeg(px, jpeg));
      const took = profile ? await comp.prof.end() : null;
      if (comp.take) memory.postMessage({ w: comp.pw, h: comp.ph });
      else if (ws) ws.send(px); else window.__last = px;
      return took ? [comp.pw, comp.ph, took] : [comp.pw, comp.ph];
    } finally { comp.take = null; if (profile) comp.prof.cancel(); }
  }
  // (progress: shown while it is drawn, the frame so far now and then: sentSoFar)
  window.__frame = async (t, sub, shutter, fps, scale = 1, overrides = undefined, look = 'accurate', jpeg = 0, profile = false, progress = false, inMemory = false) => {
    if (gpuError) throw new Error(`GPU error: ${gpuError}`);
    return sent(() => drafted(overrides, () => render(t, sub, shutter, fps, null, false, look ?? 'accurate', scale, { show: progress ? sentSoFar : null })), jpeg, profile, inMemory);
  };
  // A worker's shaders made ready before it draws a frame anyone waits for: a small frame at each moment that asks for
  // ones another does not (the renderer's wants), found by asking the film's code four times a second, at most 400
  // moments in all, and down to a frame wherever two of those differ (doctor-who asks for a shader of several seconds for two frames) →
  // { moments, ms }. Each page compiles its own, so one that met them in mid-film would hold the frame it was drawing.
  window.__warm = async (fps, look = 'accurate') => {
    const began = performance.now(), dur = film.duration ?? 0, n = Math.min(400, Math.ceil(dur * 4)), moments = new Map();
    comp.look = look;
    const see = (t) => { const w = comp.wants(sceneAt(t)); if (!moments.has(w)) moments.set(w, t); return w; };
    const between = (a, wa, b, wb) => { if (wa === wb || b - a <= 1 / fps) return; const m = (a + b) / 2, wm = see(m); between(a, wa, m, wm); between(m, wm, b, wb); };
    let a = 0, wa = see(0);
    for (let k = 1; k <= n; k++) { const b = (k / n) * dur * 0.9999, wb = see(b); between(a, wa, b, wb); a = b; wa = wb; }
    // (every moment's pipelines asked for at once, made side by side; then a small frame at each, for what was not foreseen)
    for (const t of moments.values()) await comp.prepare(sceneAt(t));
    await comp.ready().catch(() => {});   // (one that failed fails the frame that draws with it, below, saying why)
    for (const t of moments.values()) await render(t, 2, 0, fps, null, false, look, 0.25);
    return { moments: moments.size, ms: Math.round(performance.now() - began) };
  };
  // a frame drawn on past its own sub-frames, as the editor's viewer converges on a paused frame: n in all, spread over
  // its shutter, lens and pixel; each call draws on for about `budget` ms of the GPU's and sends the frame so far, or the
  // whole of it once all n are drawn → [w, h, { done, sub }]. A call with the same key goes on from where the last left
  // off, unless the page has drawn anything else since (then it begins again)
  // (camera: the director's view's, at rest: as __director draws it, at t alone and without the film's post, its sub-frames
  // spread over the pixel)
  window.__converge = async (key, t, n, shutter, fps, scale = 1, overrides = undefined, look = 'accurate', jpeg = 0.85, budget = 150, camera = null, inMemory = false) => {
    if (gpuError) throw new Error(`GPU error: ${gpuError}`);
    let step = null;
    const [w, h] = await sent(() => drafted(overrides, async () => {
      const g = going?.key === key ? going : { key, F: await render(t, n, shutter, fps, camera, false, look ?? 'accurate', scale, { prepare: true, cap: Math.max(64, n) }), done: 0 };
      const end = performance.now() + budget;
      do { await drawSub(g.F, g.done++); await dev.queue.onSubmittedWorkDone(); } while (g.done < g.F.sub && performance.now() < end);
      step = { done: g.done, sub: g.F.sub };
      const px = await comp.finish(finishOf(g.F), g.done < g.F.sub ? g.F.sub / g.done : 0);
      going = g.done < g.F.sub ? g : null;
      return px;
    }), jpeg, false, inMemory);
    return [w, h, step];
  };
  // the director's view: the scene at t from `camera` (a camera like the film's: x, y, z, zoom, yaw, pitch, roll,
  // focal), drawn at `scale` of the frame's size, as __frame sends it
  // (live: playing — draw now, as the layers were last captured, while the page catches up)
  // (overrides: the editor's changes as they would be, for this view only — a gizmo's drag, drawn as it goes)
  window.__director = async (t, camera, scale = 1, live = false, overrides = undefined, look = 'accurate', jpeg = 0, profile = false, inMemory = false) => {
    if (gpuError) throw new Error(`GPU error: ${gpuError}`);
    return sent(() => drafted(overrides, () => render(t, 1, 0, 60, camera, live, look ?? 'accurate', scale)), jpeg, profile, inMemory);
  };
  // the editor's changes as they would be, for one request (undefined: as the timeline has them; null: so too, asked as
  // the editor's own film draws, urgently: no question about the film runs meanwhile, inGaps, nor sees a draft)
  async function drafted(list, fn) {
    if (list === undefined) return fn();
    const own = list !== null;
    if (own) { draft(list); viewAt = null; }
    urgent++;
    try { return await fn(); } finally { urgent--; urgentAt = performance.now(); if (own) { draft(null); viewAt = null; } }
  }
  // the timeline's changes, edited (and only they: its cues and the rest are read as the film loads): taken in as they
  // are, the film not loaded again — its frames are those a page loaded with them draws
  window.__overrides = (list) => { saved = list ?? []; draft(null); viewAt = null; placedAt = null; placedSince++; overridesGen++; window.__viewChanged?.(); return true; };
  let overridesGen = 0;
  // the film's camera at each of `times`: its kind, where it is, which way it looks (its axes), its lens, and what it
  // frames: its pose as the orbit camera that sees the same (lens.js asOrbit: x, y, z its centre, the frame there
  // W / zoom wide; yaw and pitch as it faces), which the editor draws and turns
  // (overrides: the editor's, before they are saved)
  window.__cameraPath = async (times, overrides = undefined) => {
    if (overrides === undefined) { const poses = []; await inGaps(times, undefined, (t, i, s) => poses.push(poseOf(cameraOf(s.camera, t), t))); return poses; }
    draft(overrides);
    try { return cameraPath(times); } finally { draft(null); }
  };
  const cameraPath = (times) => times.map((t) => poseOf(cameraAt(t), t));
  const poseOf = (c, t) => {
    const B = basis(c), o = asOrbit(c);
    return { t, kind: c.kind ?? 'orbit', camera: { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0, zoom: o.zoom, yaw: o.yaw, pitch: o.pitch, roll: o.roll, focal: B.focal }, eye: B.eye, right: B.right, down: B.down, back: B.back };
  };

  // the editor's picking: what is under frame point (x, y) at t, seen by `camera` (the director's) or the film's own (null)
  window.__pick = async (t, camera, x, y) => {
    // its layers' pictures at t first (where they are see-through counts)
    const need = [...new Set(film.scene(t).nodes.filter((n) => n?.layer instanceof Layer).map((n) => n.layer))].filter((L) => !L.gpu || L.needsCapture(t));
    if (need.length) { await domAtFree(t); viewAt = null; for (const L of need) L.hold(t); await host.nextPaint(); capture(need, t); }
    const s = traced(sceneAt, t, camera);
    let h = await pickAt(s, x, y, dev);
    // what the film's own passes draw there (those that say so: fn pick, see pass.js), if it is nearer: the thing its id
    // names, by label (a light the pass draws: its F.light), or the pass itself
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i];
      if (!n?.pass?.picks || (h && h.t <= 0)) continue;
      const g = await comp.pickPass(n, s, x, y);
      if (!g || (h && h.t <= g.t)) continue;
      const label = n.pass.pickTo?.(g.id), k = label == null ? -1 : s.nodes.findIndex((m) => m?.label === label);
      const { P, D } = rayAt(s.camera, x, y);
      h = { node: k >= 0 ? k : i, copy: 0, t: g.t, point: [0, 1, 2].map((a) => P[a] + D[a] * g.t) };
    }
    return h ? describe(s, h.node, h.copy, camera, h.point) : null;
  };
  // where a picked thing is at another moment (or from another camera), found again by where the film's code placed it
  // (at: file:line:col; nth: which of the nodes placed there) and its copy; null where it is not in the scene then
  // (sel: which copy — { key, like, copy }, see matchCopy — among the nodes that call placed as that one)
  window.__locate = (t, camera, at, nth, sel = {}, overrides = undefined) => {
    if (overrides === undefined) return locate(t, camera, at, nth, sel);
    draft(overrides);
    try { return locate(t, camera, at, nth, sel); } finally { draft(null); }
  };
  const locate = (t, camera, at, nth, sel) => locateIn(traced(sceneAt, t, camera), camera, at, nth, sel);
  const locateIn = (s, camera, at, nth, sel, most = 3000) => {
    const nths = nthsOf(s.nodes);
    if (sel.sites) return locateObject(s, nths, camera, at, nth, sel, most);
    const r = copyAt(s, nths, at, nth, sel);
    return r && describe(s, r.k, r.c, camera);
  };
  // the node and copy where the code placed it (at, nth) and which copy it is (sel), or null
  const copyAt = (s, nths, at, nth, sel) => {
    const mine = s.nodes.map((n, k) => (n && siteOf(n.site)?.at === at && nths[k] === nth ? k : -1)).filter((k) => k >= 0);
    if (!mine.length) return null;
    // a copy with a material of its own draws as a node of its own: all of them are candidates
    const all = mine.flatMap((k) => (s.nodes[k].instances ?? [null]).map((it, c) => ({ k, c, it })));
    if (!s.nodes[mine[0]].mesh) return { k: mine[0], c: 0 };
    const j = all.length === 1 ? 0 : matchCopy(all.map((a) => a.it.__orig ?? a.it), sel);
    return j < 0 ? null : all[j];
  };
  // an object, whole (sel.sites: the lines that place it; see __objects): the copy it was picked by (at, nth, sel) as
  // locate describes one, or where that is not in the scene its first; with how many copies it has there (count) and
  // the copies on the frame seen by `camera` (members: the largest `most`, each its corners in the world, which the
  // editor sees through the camera of its picture, or a copy on the screen its outline)
  const locateObject = (s, nths, camera, at, nth, sel, most) => {
    const sites = new Set(sel.sites), all = [];
    s.nodes.forEach((n, k) => { if (n && sites.has(siteOf(n.site)?.at)) for (let c = 0; c < (n.instances?.length ?? 1); c++) all.push({ k, c }); });
    if (!all.length) return null;
    const ref = (at != null && sites.has(at) && copyAt(s, nths, at, nth, sel)) || all[0];
    const r = describe(s, ref.k, ref.c, camera), cam = camera ?? s.camera;
    const area = (q) => Math.abs(q.reduce((a, p, i) => a + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0)) / 2;
    const seen = all.map(({ k, c }) => { const box = corners(s.nodes[k], c); return { q: outline(s.nodes[k], c, cam, box), box }; })
      .filter(({ q }) => q?.length > 2 && q.some((p) => p[0] > -W * 0.1 && p[0] < W * 1.1 && p[1] > -H * 0.1 && p[1] < H * 1.1))
      .map((m) => ({ ...m, a: area(m.q) })).sort((a, b) => b.a - a.a).slice(0, most);
    r.count = all.length;
    r.members = seen.map(({ q, box }) => (box ?? q).map((p) => p.map((v) => Math.round(v * 2) / 2)));
    return r;
  };

  // what __objects saw placed at each line (the things defined, its moments), so that a thing's lanes over the same
  // moments take the sites of only the nodes placed there (a call stack each, at every frame: most of a sweep's cost);
  // forgotten when the timeline's changes do (they may change what the code places)
  let placedAt = null, placedSince = 0;
  // the film's objects over its whole length, as the editor lists and selects them: each a thing the code defines (a
  // mesh, a layer, a light, a pass) with every line that places it, and everything one line places (a loop's, a
  // many()'s copies) — so a field of pillars two lines place, near and far, is one object, and the steles a loop
  // places another; and each thing the director added (added: true). Sampled `fps` times a second and at each cut:
  // { id (its first line), sites (the lines that place it: file:line:col), label, kind, spans ([t0, t1]: where it is in
  // the scene), copies (the most at once) }, in the order they first appear. (The timeline's pictures are on its tracks:
  // not here.)
  window.__objects = async ({ duration, fps = 12, cuts = [] }) => {
    const frames = Array.from({ length: Math.floor(duration * fps + 1e-6) + 1 }, (_, f) => f / fps);
    const times = [...new Set([...frames, ...cuts.filter((c) => c > 0 && c < duration)])].sort((a, b) => a - b);
    // (the lines and the things defined, joined where a node has both: what is joined is one object)
    const up = new Map();
    const root = (k) => { if (!up.has(k)) up.set(k, k); let r = k; while (up.get(r) !== r) r = up.get(r); up.set(k, r); return r; };
    const join = (a, b) => { const ra = root(a), rb = root(b); if (ra !== rb) up.set(rb, ra); };
    const defined = new Map(), lines = new Map(), things = new Map();   // (a thing defined → its name; a line → what it placed when, and which things)
    const since = placedSince;
    await inGaps(times, true, (t, i, s) => {
      for (const n of s.nodes) {
        const site = siteOf(n?.site);
        if (!site?.at || (site.clip && !site.added)) continue;
        // (an added thing is an object of its own, though it shares its mesh with the others of its shape)
        const what = site.added ? null : n.mesh ?? n.layer ?? n.of;
        if (what) { if (!defined.has(what)) defined.set(what, `#${defined.size}`); join(site.at, defined.get(what)); } else root(site.at);
        if (!things.has(site.at)) things.set(site.at, new Set());
        if (what) things.get(site.at).add(what);
        let l = lines.get(site.at);
        if (!l) lines.set(site.at, (l = { at: site.at, file: site.file, line: site.line, col: site.col, first: i, counts: new Map(), labels: new Set(), kind: kindOf(n) === 'layer' && n.screen ? 'title' : n.mesh && n.material?.glass ? 'glass' : kindOf(n) }));
        l.counts.set(i, (l.counts.get(i) ?? 0) + (n.instances?.length ?? 1));
        const label = labelOf(n);
        if (label) l.labels.add(label);
      }
    });
    if (since === placedSince) placedAt = { times: new Set(times), things };
    const groups = new Map();
    for (const l of lines.values()) { const r = root(l.at); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); }
    const out = [...groups.values()].map((ls) => {
      ls.sort((a, b) => a.first - b.first || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.col - b.col));
      const at = new Map();   // (how many copies at each time)
      for (const l of ls) for (const [i, c] of l.counts) at.set(i, (at.get(i) ?? 0) + c);
      const idx = [...at.keys()].sort((a, b) => a - b), spans = [];
      for (const i of idx) { const last = spans[spans.length - 1]; if (last && last.i === i - 1) { last.i = i; last[1] = times[i + 1] ?? duration; } else spans.push(Object.assign([times[i], times[i + 1] ?? duration], { i })); }
      const kinds = new Set(ls.map((l) => l.kind));
      return { id: ls[0].at, sites: ls.map((l) => l.at), label: commonLabel([...new Set(ls.flatMap((l) => [...l.labels]))]), kind: kinds.size === 1 ? ls[0].kind : 'mixed',
        file: ls[0].file, line: ls[0].line, first: ls[0].first, spans: spans.map(([a, b]) => [a, b]), copies: Math.max(...at.values()), ...(ls[0].at.startsWith('clip:') && { added: true }) };
    });
    out.sort((a, b) => a.first - b.first || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return out.map(({ first, ...o }) => o);
  };

  // a thing's properties the lanes show (a light: where it is and its own numbers, a spot's cone too)
  // (an added mesh: its scale along each of its own axes, in place of one number; a spot and a sun can be turned)
  const propsOf = (n) => (n.pass ? [...(n.pass.bounds ? PLACED : []), ...numericParams(n)] : n.light ? ['x', 'y', 'z', ...(n.light === 'point' ? [] : ['rx', 'ry', 'rz']), ...lightNumbers(n.light)] : n.mesh ? [...(n.added ? PLACED_AXES : PLACED), ...MATERIAL, ...editable(n.surface?.params)] : [...PLACED, 'opacity']);
  const kindOf = (n) => (n.pass ? 'pass' : n.light ? 'light' : n.mesh ? 'mesh' : 'layer');
  const labelOf = (n) => n.label || n.layer?.label || n.mesh?.label || '';
  // a thing's properties (or the camera's, or the scene's own settings) at t, each with the code's stack it came from (a
  // motion or a rig, as plain data: describe()), or none (the code computes it: its values over time come from
  // __samples) — what the agent asks
  window.__stacks = (t, sel) => {
    const s = traced(sceneAt, t, null), raw = traced(film.scene, t, null);
    const desc = (f, k) => (f ? { stack: f.stack.describe(), ch: f.ch } : {});
    // (and how the scene asks its light traced, which the timeline's rendering may set over: Renderer; its glass's
    // bounces, each one's, as one number or the least to the most)
    if (sel.scene) {
      const b = [...new Set(raw.nodes.filter((n) => n?.mesh && n.material?.glass).map((n) => n.material.bounces))].sort((x, y) => x - y);
      const glass = { bounces: b.length > 1 ? `${b[0]}–${b.at(-1)}` : b[0] };
      return { kind: 'scene', label: 'Scene', props: SCENE.map((k) => ({ k, value: sceneValue(s, k), code: sceneValue(raw, k) })), rendering: { gi: raw.gi, shadows: raw.shadows, reflections: raw.reflections, glass } };
    }
    if (sel.camera) {
      const from = raw.camera?.[STACKS] ?? {};
      return { kind: 'camera', label: 'Camera', props: CHANNELS[raw.camera?.kind ?? 'orbit'].map((k) => ({ k, value: cameraValue(s.camera, k), code: cameraValue(raw.camera, k), ...desc(from[k]) })) };
    }
    const f = findPlaced(raw.nodes, sel), g = findPlaced(s.nodes, sel);
    if (!f) return null;
    const from = { ...(f.n[STACKS] ?? {}), ...(f.it?.[STACKS] ?? {}) };
    return { kind: kindOf(f.n), label: labelOf(f.n),
      props: propsOf(f.n).map((k) => ({ k, value: g ? codeValue(g.n, g.it, k) : null, code: codeValue(f.n, f.it, k), ...desc(from[k]) })).filter((p) => p.code != null) };
  };
  // the editor's lanes, over the whole film: at every frame (and every cut), what gives each of a thing's properties
  // (or the camera's, or the scene's own numbers: the code's) — a motion (its id), the code (null), or nothing (false: the thing is not in the scene, or the
  // camera is of a kind without it) — as runs { t0, t1 (null: on to the end), id, ch, after, v }, each motion
  // described once; `after`: the camera's pose differs from its motion's somewhere in the run (the code changes it
  // after the motion: a shake), so the lanes add what the code does (__samples d); v: the value where the run starts;
  // and whether the property changes over the film at all (varies). Of the code alone, as the frames have it.
  // values: and, of a property the code computes somewhere (or changes after its motion), its value at each of `times`
  // (vals: null where it is not in the scene) and what the code does after the motion (d, in its channel space), which
  // the editor draws the Code lanes from (a frame's own values: no sampling of the film again as its view moves).
  // Of each of `sels` (the camera, the scene, a thing as pick names it) from one evaluation of each moment (one alone, as
  // a studio started before it asked for several: its answer). (at: of that moment alone, as if for the whole film: all that
  // setting a value at the playhead needs, what gives it there and its value; overrides: the editor's, before they are saved.)
  window.__lanes = async (sels, { duration, fps = 60, cuts = [], values = false, at = null }, overrides = undefined) => {
    const one = !Array.isArray(sels);
    if (one) sels = [sels];
    const frames = Array.from({ length: Math.floor(duration * fps + 1e-6) + 1 }, (_, f) => f / fps);
    const times = at != null ? [at] : [...new Set([...frames, ...cuts.filter((c) => c > 0 && c < duration)])].sort((a, b) => a - b);
    // (per property: [id, ch, after, value, d] at each time)
    const each = sels.map((sel) => ({ sel, kind: sel.scene ? 'scene' : 'camera', label: sel.scene ? 'Scene' : 'Camera', stacks: {}, seen: new Map() }));
    const note = (e, k, i, v) => { if (!e.seen.has(k)) e.seen.set(k, new Array(times.length).fill(false)); e.seen.get(k)[i] = v; };
    const desc = (e, f) => { e.stacks[f.stack.id] ??= f.stack.describe(); return f.stack.id; };
    const things = sels.filter((sel) => !sel.camera && !sel.scene);
    // (things': the sites of what is placed at their lines, where __objects saw all of the same moments)
    const sites = things.length ? placedAt && times.every((t) => placedAt.times.has(t)) ? new Set(things.flatMap((sel) => [...(placedAt.things.get(sel.at) ?? [])])) : true : undefined;
    const moment = (t, i, s = film.scene(t)) => {
      for (const e of each) {
        const { sel } = e;
        if (sel.scene) { for (const k of SCENE_NUMBERS) note(e, k, i, [null, null, false, sceneValue(s, k)]); continue; }
        if (sel.camera) {
          const c = s.camera, from = c?.[STACKS] ?? {}, poses = new Map();
          for (const k of CHANNELS[c?.kind ?? 'orbit']) {
            const f = from[k];
            const b = cameraValue(c, k);
            if (!f) { note(e, k, i, [null, null, false, b]); continue; }
            if (!poses.has(f.stack)) poses.set(f.stack, f.stack.at(t));
            const p = poses.get(f.stack)[k], lg = f.stack.log.has(f.ch);
            note(e, k, i, [desc(e, f), f.ch, Math.abs(p - b) > 1e-9 * Math.max(1, Math.abs(b)), b, lg ? Math.log(b) - Math.log(p) : b - p]);
          }
          continue;
        }
        const f = findPlaced(s.nodes, sel);
        if (!f) continue;
        if (!e.found) Object.assign(e, { found: true, kind: kindOf(f.n), label: labelOf(f.n) });
        const from = { ...(f.n[STACKS] ?? {}), ...(f.it?.[STACKS] ?? {}) };
        for (const k of propsOf(f.n)) { const v = codeValue(f.n, f.it, k); if (v != null) note(e, k, i, from[k] ? [desc(e, from[k]), from[k].ch, false, v] : [null, null, false, v]); }
      }
    };
    // (one moment is over at once, and as the editor has the film: a thing it has just added may not have reached this page)
    if (at == null) await inGaps(times, sites, moment);
    else {
      const was = globalThis.__sites;
      if (overrides !== undefined) draft(overrides);
      if (sites !== undefined) globalThis.__sites = sites;
      try { moment(at, 0); } finally { if (overrides !== undefined) draft(null); globalThis.__sites = was; }
    }
    const n7 = (x) => +x.toPrecision(7);
    const out = each.map(({ sel, kind, label, stacks, seen, found }) => {
      if (!sel.camera && !sel.scene && !found) return null;   // (never in the scene)
      const order = sel.camera ? CAMERA : sel.scene ? SCENE_NUMBERS : [...seen.keys()];
      const props = order.filter((k) => seen.has(k)).map((k) => {
        const at = seen.get(k), runs = [];
        let lo = Infinity, hi = -Infinity;
        at.forEach((v, i) => {
          if (v) { lo = Math.min(lo, v[3]); hi = Math.max(hi, v[3]); }
          const id = v === false ? false : v[0], last = runs[runs.length - 1];
          if (last && last.id === id) { last.after ||= v[2]; return; }
          if (last) last.t1 = times[i];
          runs.push(v ? { t0: at != null ? 0 : times[i], t1: null, id, ch: v[1], after: v[2], v: v[3] } : { t0: times[i], t1: null, id: false });
        });
        const varies = hi - lo > 1e-9 * Math.max(1, Math.abs(hi)), after = runs.some((r) => r.after);
        if (!values || !(after || (varies && runs.some((r) => r.id === null)))) return { k, runs, varies };
        return { k, runs, varies, vals: at.map((v) => (v ? n7(v[3]) : null)), ...(after && { d: at.map((v) => (v?.[4] ? n7(v[4]) : 0)) }) };
      });
      return { kind, label, props, stacks, ...(values && { times: times.map((t) => +t.toFixed(6)) }) };
    });
    return one ? out[0] : out;
  };
  // the code's own values of a thing's properties (or the camera's, or the scene's) at each of `times`, without the editor's changes;
  // and, for the camera, what the code does to each after its motion (a shake: d, in the motion's channel space)
  window.__samples = async (sel, ks, times) => {
    // (a thing is found by where the code placed it, which costs a call stack per node; the camera needs none)
    const out = [];
    await inGaps(times, !sel.camera && !sel.scene ? true : undefined, (t, i, s) => out.push((() => {
      if (sel.scene) return { v: ks.map((k) => sceneValue(s, k)) };
      if (sel.camera) {
        const c = s.camera, from = c?.[STACKS] ?? {};
        const v = ks.map((k) => cameraValue(c, k));
        return { v, d: ks.map((k, j) => { const f = from[k]; if (!f) return 0; const lg = f.stack.log.has(f.ch); return (lg ? Math.log(v[j]) : v[j]) - f.stack.value(f.ch, t); }) };
      }
      const f = findPlaced(s.nodes, sel);
      return { v: ks.map((k) => (f ? codeValue(f.n, f.it, k) : null)) };
    })()));
    return out;
  };

  // the scene's own lights at t, as the editor marks them in the viewer, seen by `camera` (the director's) or the film's
  // (null): where each is on the frame, its kind and colour, where a spot points (on the frame), and where its code
  // placed it (to select it)
  // (each in the world too, point and a spot's aim 160 px along its way, for an editor whose camera moves: x and y are
  // null for one behind `camera`)
  window.__lights = (t, camera) => lightsIn(traced(sceneAt, t, camera));
  const lightsIn = (s) => {
    const B = basis(s.camera), nths = nthsOf(s.nodes);
    return s.nodes.flatMap((n, i) => {
      if (!n?.light) return [];
      const at = [n.x ?? 0, n.y ?? 0, n.z ?? 0], p = project(at, B), seen = p.depth > 1;
      let aim = null, toward = null;
      // (where a spot or a sun shines, 160 px along its way)
      if (n.light !== 'point') { const dir = lightWay(n, at), l = Math.hypot(...dir) || 1, q = project((aim = at.map((v, k) => v + (dir[k] / l) * 160)), B); if (seen && q.depth > 1) toward = [q.x, q.y]; }
      const site = siteOf(n.site);
      return [{ x: seen ? p.x : null, y: seen ? p.y : null, point: at, aim, type: n.light, color: n.color, label: n.label, at: site?.at ?? null, nth: site ? nths[i] : 0, toward }];
    });
  };

  // what the editor draws over its picture of each of `times` (the overlays), so that they are of the picture's own frame:
  // the film's camera there (as cameraPath gives it), the scene's lights (as __lights), and the selection `sel` (as
  // locate finds it, a whole object's copies at most 6000 over seven frames or all the times), as the editor has the film (overrides:
  // its draft); `camera`: the director's, whose view leaves out what is on the screen
  // (also: the other things selected with sel, each found as it is)
  window.__overlays = (times, sel, overrides = undefined, camera = null, also = []) => {
    if (overrides !== undefined) draft(overrides);
    try {
      const most = Math.max(50, Math.floor(6000 / Math.max(7, times.length)));
      return times.map((t) => overlaysIn(traced(sceneAt, t, null), t, sel, camera, also, most));
    } finally { if (overrides !== undefined) draft(null); }
  };
  // (in s, the scene at t with every call site taken: seen by `camera`, or the film's)
  const overlaysIn = (s, t, sel, camera, also, most) => {
    const view = camera ? { ...s, camera, nodes: s.nodes.filter((n) => n && !n.screen) } : s;
    return { t, camera: poseOf(s.camera, t), lights: lightsIn(s), ...(sel && { sel: locateIn(view, camera, sel.at, sel.nth ?? 0, sel, most) }),
      ...(also?.length && { also: also.map((a) => locateIn(view, camera, a.at, a.nth ?? 0, a, most)) }) };
  };

  // the scene's passes at t (see pass.js), as the editor lists them to select one (a pass covers the frame: it is not
  // picked by a click): its label, stage, params, and where its code placed it
  window.__passes = (t) => {
    const s = traced(sceneAt, t, null), nths = nthsOf(s.nodes);
    return s.nodes.flatMap((n, i) => {
      if (!n?.pass) return [];
      const site = siteOf(n.site);
      return [{ label: n.label, stage: n.pass.stage, params: n.params, at: site?.at ?? null, nth: site ? nths[i] : 0 }];
    });
  };

  // how the film moves on screen from `from` to `to`, sampled `fps` times a second (no frames drawn: the scene is a
  // function of t): the film camera's on-screen speed (px between samples: screenShift, as check --momentum measures
  // it), where the previous sample's frame centre lands now (a reversal is a snap-back), whether anything in the world
  // is in view; and where each of `things` is on the frame (a placed thing, as pick names it: { at, nth, key, like, copy };
  // or a world point: { point: [x, y, z] }), as the editor has the film (its changes, its draft)
  window.__track = (from, to, fps = 60, things = []) => {
    const N = Math.max(1, Math.min(4000, Math.round((to - from) * fps))), shot = (t) => cuts.filter((c) => t >= c - 1e-6).length, out = [];
    let prev = null;
    for (let f = 0; f <= N; f++) {
      const t = from + f / fps, s = things.some((x) => x.at) ? traced(sceneAt, t, null) : sceneAt(t), cam = s.camera, B = basis(cam);
      const same = prev && shot(prev.t) === shot(t), row = { t: +t.toFixed(4), shot: shot(t), world: s.nodes.some((n) => n && !n.screen && (n.opacity ?? 1) > 0.05) };
      if (same) {
        row.speed = +screenShift(prev.cam, cam).toFixed(3);
        const p = project(basis(prev.cam).center, B);
        row.centre = [+(p.x - W / 2).toFixed(2), +(p.y - H / 2).toFixed(2)];
      }
      row.things = things.map((x) => {
        let at = x.point;
        if (!at) { const g = findPlaced(s.nodes, x); if (!g) return null; const o = g.it ?? g.n; at = [o.x ?? 0, o.y ?? 0, o.z ?? 0]; if (g.n.screen) return [+(o.x ?? 0).toFixed(1), +(o.y ?? 0).toFixed(1)]; }
        const q = project(at, B);
        return q.depth > 1 ? [+q.x.toFixed(1), +q.y.toFixed(1)] : null;
      });
      out.push(row); prev = { t, cam };
    }
    return out;
  };

  // (what the director is waiting on: see urgently)
  for (const k of ['__frame', '__director', '__pick', '__locate', '__overlays']) window[k] = urgently(window[k]);
  // (the renderer's pipelines, asked for as it was set up, made: away from the GPU process's main thread, side by side)
  await comp.ready();
  window.__ready = true;
  // The editor's own film: a page in a frame of the editor's window (?viewport: nle/viewport.js), in a process of its own,
  // asked what its viewer, its timeline and its agents want to know on a port the editor gives it: each { id, call, args }
  // answered { id, ok } or { id, error }, call one of the page's own (__lanes, __pick…, without the __).
  // (remote: the page of the viewport's render process, app/viewport.cjs: its frames go into a ring of images the editor's
  // window shares, app/frames.cjs, and the editor draws what goes over them and takes the pointer, nle/viewport.js)
  // (an Electron without experiments/native-renderer/zero-copy's patches cannot write a frame into the images it shares:
  // said, and the editor shows what the studio's workers draw)
  const shares = typeof dev.importSharedTexture === 'function';
  if (params.get('viewport') === 'worker' && !shares) parent.postMessage({ ephemeris: 'viewport-failed', error: 'this Electron cannot write into the frames the editor shares (no GPUDevice.importSharedTexture: built without experiments/native-renderer/zero-copy\'s patches)' }, '*');
  const remote = params.get('viewport') === 'worker' && !!window.__viewportFrames && shares;
  if (params.get('viewport') && (parent !== window || remote)) {
    let port = null;
    const serve = (p) => {
      port = p;
      port.onmessage = async ({ data: { id, call, args } }) => {
        try { port.postMessage({ id, ok: await window[`__${call}`](...(args ?? [])) }); }
        catch (e) { port.postMessage({ id, error: String(e?.message ?? e) }); }
      };
    };
    addEventListener('message', (e) => { if (e.source === parent && e.data === 'ephemeris-viewport' && e.ports[0]) serve(e.ports[0]); });
    // Its viewer: what the editor shows (__view(state)), drawn onto a canvas of the page's own where the editor puts its
    // picture (state.place: CSS px of the page, which is the editor's screen), so that no frame is read back, encoded or
    // sent. The Director view: the scene at t from the director's camera (or, 'film', the film camera's then), a quick
    // frame of one sub-frame while it moves or plays (smaller: state.scale), and at rest drawn on, sub-frame by sub-frame,
    // n in all, the frame so far shown as it goes. Over it, with each frame, what the editor's viewer draws there and what
    // the pointer and the keys do (viewport.js: the layer); each frame shown is told to the editor ({ event: 'shown',
    // camera, t, done, sub }).
    const screen = document.createElement('canvas'), shown = remote ? ringOf(dev, window.__viewportFrames) : screen.getContext('webgpu');
    Object.assign(screen.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', display: 'none', background: '#000' });
    if (!remote) {
      document.body.append(screen);
      document.documentElement.style.background = document.body.style.background = '#000';
      shown.configure({ device: dev, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST, alphaMode: 'opaque' });
    }
    // The GPU can lose the page's device (its process restarted, its driver reset, the GPU taken away), and the picture on
    // the canvas with it, within a second. So the picture shown is kept in memory too, on a canvas drawn by the CPU
    // (still): at most four times a second, and once the view is at rest (keepStill, before the idle work). Where the
    // device is lost, the still shows in its place and the editor loads the film again (nle/viewport.js), this page
    // staying as it is until the new one is ready. (A copy of the canvas taken later than the task that drew it is blank.)
    const still = document.createElement('canvas'), stillG = still.getContext('2d', { willReadFrequently: true });
    Object.assign(still.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483646', display: 'none' });
    document.body.append(still);
    let shownN = 0, keptN = 0, keptAt = -Infinity, shownBmp = null, lost = false;
    const put = (w, h, draw) => { if (lost) return; if (still.width !== w || still.height !== h) { still.width = w; still.height = h; } try { draw(); } catch { keptN = 0; } };   // (the cache's bitmap closed meanwhile)
    // (the renderer's frame is copied at once and read back meanwhile, the next drawn as it is: Renderer.read; at rest, once
    // the one on its way is in)
    function keepStill() {
      if (remote || lost || keptN === shownN) return null;
      const bmp = shownBmp;
      if (bmp) { keptN = shownN; keptAt = performance.now(); put(bmp.width, bmp.height, () => stillG.drawImage(bmp, 0, 0)); return null; }
      const reading = comp.read();
      if (!reading) return null;
      keptN = shownN; keptAt = performance.now();
      return reading.then(({ px, w, h }) => put(w, h, () => stillG.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), w, h), 0, 0)), () => {});
    }
    // (a picture put on the canvas: the renderer's frame, or a bitmap of the cache's)
    const presented = (bmp = null) => { shownN++; shownBmp = bmp; if (performance.now() - keptAt >= 250) keepStill(); };
    dev.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      lost = true;
      if (keptN) { const { left, top, width, height, display } = screen.style; Object.assign(still.style, { left, top, width, height, display }); }
      screen.style.display = 'none';
      parent.postMessage({ ephemeris: 'viewport-lost', message: info.message }, '*');
    });
    let want = null, drawing = false, shownKey = '', rest = null, nudgeKey = 'null', sitesWere, shownDone = 0;   // (shownDone: the sub-frames of the view's frame shown)
    const tell = (event, data) => {
      if (event === 'shown') { saidNow = null; framing = false; if (remote) return shown.shown(data, shownFr); }
      port?.postMessage({ event, ...data });
    };
    // What it is doing for the frame the viewer asked, said as each stage starts (the page can say nothing while one
    // runs), for the editor's badge once the frame is late (nle/viewport.js late): a change of stage at a time; and so
    // what it was doing when the frame was asked, its idle work, which the frame waits for
    let saidNow = null, framing = false;
    const say = (what) => { if (what !== saidNow) { saidNow = what; port?.postMessage({ event: 'working', what }); } };
    const saying = (s) => (s?.playing ? null : (what) => { framing = true; say(what); });
    const place = (p) => { if (!p || remote) return; const px = (v) => `${Math.round(v * 100) / 100}px`; Object.assign(screen.style, { left: px(p.left), top: px(p.top), width: px(p.width), height: px(p.height), display: 'block' }); };
    // (a view of its own shape: the part of the film's frame it shows, [w, h] px about the centre; the canvas over that
    // part of the place, which the overlays keep, the film's frame)
    // (in steps of 32 px, rounded up: a panel resized a pixel at a time has the renderer draw into new textures once a step,
    // not each time, the canvas reaching past the panel by the rest, cut off there)
    const step = (v, most) => Math.min(most, Math.ceil(v / 32) * 32);
    // (the canvas where the picture on it belongs, the part of the frame it was drawn of, as soon as the editor's screen
    // changes (a panel resized), even while the next is drawn; the next one's place once it is shown, in the same task)
    let shownFr = null;
    const placeShown = (p) => place(within(p, shownFr));
    const frameOf = (s) => (Array.isArray(s.frame) && s.frame.every((v) => Number.isFinite(v) && v >= 64) ? [step(s.frame[0], W), step(s.frame[1], H)] : null);
    // (while the panel is resized, its part of the frame changing as it goes, the whole of the film's frame is drawn, the
    // panel showing a part of it as it is, rather than a frame of each shape it passes through, each a heavy film's quick
    // frame; once it has been still a moment, only the part it shows)
    let frameWas = null, frameMoved = -Infinity;
    const frameNow = (s) => {
      const fr = frameOf(s), k = JSON.stringify(fr);
      if (frameWas === null) frameWas = k;
      else if (k !== frameWas) { frameWas = k; frameMoved = performance.now(); }
      const since = performance.now() - frameMoved;
      if (since < 250) { setTimeout(kick, 260 - since); return null; }
      return fr;
    };
    const within = (p, fr) => (fr && p ? { left: p.left + (p.width * (1 - fr[0] / W)) / 2, top: p.top + (p.height * (1 - fr[1] / H)) / 2, width: (p.width * fr[0]) / W, height: (p.height * fr[1]) / H } : p);
    const agentJobs = [];   // (what agents asked it to draw: agentTurn)
    const kick = () => { if ((want || agentJobs.length) && !drawing && !lost) viewer(); };
    afterQuestions = kick;
    // (a gesture's change as it goes: drawn with it, every node saying where it was placed meanwhile, as finding the
    // things it changes needs)
    const setNudge = (n) => {
      if (n && !nudge) { sitesWere = globalThis.__sites; globalThis.__sites = true; }
      if (!n && nudge) globalThis.__sites = overrides.length ? true : sitesWere;
      nudge = n; nudgeKey = JSON.stringify(n);
    };
    const [{ createViewportLayer }, { createPreviewFrames }] = await Promise.all([import('./viewport.js'), import('./preview.js')]);
    // (what goes over the frame: the things selected found, their call sites taken, only where something is selected)
    // (the Preview's frame: through the film's own camera, things on the screen among what is found)
    // (found in the film's code at t as the frame there then draws it, run once for both: known)
    const overlaysAt = (t, sel, also, draft, camera, ofFilm) => drafted(draft ?? null, () => overlaysIn(sceneAt(t, codeOf(t, !!(sel || also.length))), t, sel, ofFilm ? null : camera, also, 857));
    const moved = (camera) => { if (want) want = { ...want, camera }; kick(); return true; };
    const nudged = (n) => { if (JSON.stringify(n) === nudgeKey) return false; setNudge(n); atWork(); kick(); return true; };
    const layer = remote ? remoteLayer() : createViewportLayer({ tell, at: overlaysAt, pick: (t, camera, x, y, film) => window.__pick(t, film ? null : camera, x, y), moved, nudge: nudged });
    // (remote: the editor's layer asks these of the film, viewport.js's at, moved and nudge)
    window.__overlaysAt = (t, sel, also, draft, camera, ofFilm) => overlaysAt(t, sel, also ?? [], draft, camera, ofFilm);
    window.__moved = moved;
    window.__nudge = nudged;
    // (remote: the things selected found here where each frame has them before it is drawn, and sent with it, so that the
    // editor draws over each frame what is there in it)
    function remoteLayer() {
      let state = null, data, dataKey = '';
      const ref = (x) => x && { at: x.at, nth: x.nth, key: x.key, like: x.like, copy: x.copy, ...(x.sites && { sites: x.sites }) };
      return {
        show() {}, place() {}, view: (s) => s, key: () => false, dropped() {}, gesture: false,
        changed() { dataKey = ''; },
        setState(s) { state = s; },
        async prepare(f) {
          if (!f) return;
          const sel = ref(state?.sel) ?? null, also = (state?.also ?? []).map(ref);
          const key = JSON.stringify([f.t, f.gen, f.draft ?? null, sel, also, !!f.film]);
          if (key === dataKey) return;
          dataKey = key;
          data = await overlaysAt(f.t, sel, also, f.draft, f.camera, !!f.film);
        },
        drawn(f) { shown.overlay = { t: f.t, camera: f.camera, gen: f.gen, draft: f.draft ?? null, film: !!f.film, data }; },
      };
    }
    // (the Preview's: the frames of the studio's cache, read here, preview.js)
    const frames = createPreviewFrames({ onFrame: () => kick() });
    // (the director at work here, not playing: the studio's workers start no frame of the cache meanwhile, so that what
    // is drawn here has the GPU; said at most twice a second, each holding them 1.5 s. Playing, they go on: the frames
    // ahead of the playhead are theirs to draw)
    let heldAt = -Infinity;
    const atWork = () => { const now = performance.now(); if (now - heldAt > 500) { heldAt = now; frames.hold(1500); } };
    // (the film's code at t as this page has it, known, run again only where it is not: once a frame for its camera, what
    // goes over it and its drawing; every call site taken while something is selected, as finding it needs)
    let selecting = false;
    const codeOf = (t, sites = selecting) => {
      let code = knownAt(t, sites);
      if (!code) {
        const was = globalThis.__sites;
        if (sites) globalThis.__sites = true;
        try { code = frozen(film.scene(t)); know(t, code); } finally { globalThis.__sites = was; }
      }
      return code;
    };
    const filmCam = (t) => poseOf(cameraOf(codeOf(t).camera, t), t).camera;
    window.__view = (state) => {
      // (what the director did, not the cache's own news: the moment idle work waits after)
      const k = JSON.stringify({ ...state, cache: undefined });
      if (k !== askedKey) { askedKey = k; asked = performance.now(); if (!state.playing) atWork(); }
      want = layer.view(state);
      if (state.place && (state.view === 'film' || state.view === 'director')) { placeShown(state.place); layer.place(state.place); }
      kick(); return true;
    };
    // (what its shaders are doing, for the editor's badge, as the workers' is: engine/render/compiling.js)
    compiling.to((c) => {
      tell('compiling', { now: c.now ? [{ name: c.now, workers: 1 }] : [], done: c.done, total: c.total, workers: 1 });
      if (framing) say(c.now ? 'waiting for its shaders to compile' : 'drawing');
    });
    window.__overlayState = (state) => { selecting = !!(state?.sel || state?.also?.length); layer.setState(state); return true; };
    window.__key = (k) => layer.key(k);
    window.__committed = (ok) => { if (!ok) layer.dropped(); return true; };
    // (the timeline's changes came: a gesture's change, the edit of it among them, no longer drawn over them)
    window.__viewChanged = () => { if (nudge) setNudge(null); layer.changed(); shownKey = ''; kick(); };
    // The Preview: the film's frame at the playhead, through its own camera. Paused: the cache's frame where it shows the film
    // as the editor has it now, or else drawn now, a quick frame and then on to the cache's samples (each sub-frame
    // shown), given to the cache to keep once it is whole; Converge on, drawn on past the cache's samples, shown once it
    // has more. Playing: the cache's frames, asked for ahead of the playhead, the newest there is at or before it (frames
    // dropped); where the cache has none of the film as it is (a gesture, the editor's draft), a quick frame drawn now.
    // Each one's overlays drawn with it, and told to the editor (shown: f, done, sub, cached). The cache's parameters
    // (state.cache: its samples, shutter, size, its frames' states and sizes, whether they are of the timeline as the
    // editor has it) come with either view, for the idle fill (fill).
    const pv = { key: '', base: '', stage: '', f: null, waited: 0, kept: new Set(), keptGen: null, fill: null, shownDone: 0 };
    let lastView = null, draws = 0;   // (draws: frames drawn into the renderer here, so that the fill knows its own was set aside)
    // (remote: the bitmap into a texture of the page's own at once, as the reader may close it while an image of the ring
    // is waited for; then a GPU copy into the image, as a frame drawn here goes: copyExternalImageToTexture will not write
    // into an imported texture, whose format Blink does not know)
    let staged = null;
    const presentBitmap = async (bmp) => {
      if (remote) {
        const w = bmp.width, h = bmp.height;
        if (staged?.width !== w || staged?.height !== h) { staged?.destroy(); staged = dev.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }); }
        dev.queue.copyExternalImageToTexture({ source: bmp }, { texture: staged }, [w, h]);
        const into = await shown.acquire(w, h), enc = dev.createCommandEncoder();
        enc.copyTextureToTexture({ texture: staged }, { texture: into }, [w, h]);
        dev.queue.submit([enc.finish()]);
        shown.submitted();
      } else {
        if (screen.width !== bmp.width || screen.height !== bmp.height) { screen.width = bmp.width; screen.height = bmp.height; }
        dev.queue.copyExternalImageToTexture({ source: bmp }, { texture: shown.getCurrentTexture() }, [bmp.width, bmp.height]);
      }
      presented(bmp);
    };
    const cacheOf = (s) => {
      const C = s?.cache ?? {};
      if (C.gen !== pv.keptGen) { pv.kept.clear(); pv.keptGen = C.gen; }
      return { ...C, stateOf: (i) => (C.frames?.charCodeAt(i) || 48) - 48, sizeOf: (i) => (C.sizes?.charCodeAt(i) || 56) - 48, F: C.frames?.length ?? 0, fps: C.fps || 60 };
    };
    // (Stats on: what drawing a frame took, as a render worker's frame says it, render/profile.js: given with the frame shown)
    async function timed(s, draw) {
      if (!s?.stats) { await draw(); return null; }
      comp.prof.begin();
      try { await draw(); return await comp.prof.end(); } finally { comp.prof.cancel(); }
    }
    // What an agent asks the film to draw (the studio's api/director and api/profile, asked over the editor's link:
    // nle/viewport.js), drawn here while the director leaves the view still (IDLE_MS since they last did anything, not
    // playing): one at a time, between the view's own steps, never inside one of its frames. A frame of the view's that was
    // converging is drawn again from the start afterwards (another moment's page and pictures are not its own: rest
    // dropped), shown again only once it has more sub-frames than it showed (shownDone); the fill's begins again (draws).
    async function agentTurn(s) {
      if (!agentJobs.length || s?.playing) return false;
      if (stillFor() < IDLE_MS) { setTimeout(kick, IDLE_MS - stillFor() + 10); return false; }
      const { job, resolve, reject } = agentJobs.shift();
      rest = null; draws++;
      try { resolve(await job()); } catch (e) { reject(e); } finally { draws++; }
      return true;
    }
    const jpegOf = async (px, w, h, quality) => {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), w, h), 0, 0);
      return (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer();
    };
    // (kind 'director': the scene at t from a camera of the agent's, or the film's, one sub-frame of Accurate, as a JPEG;
    // 'profile': what drawing the frame at t takes, drawn as the studio says, its samples, shutter and size)
    window.__agentFrame = (kind, a = {}) => new Promise((resolve, reject) => {
      const t = +a.t || 0, draft = Array.isArray(a.draft) ? a.draft : null, clamp = (v, lo) => Math.min(1, Math.max(lo, +v || 1));
      const job = kind === 'director'
        ? async () => { const px = await drafted(draft, () => render(t, 1, 0, 60, a.camera ?? null, false, 'accurate', clamp(a.scale, 0.25))); return jpegOf(px, comp.pw, comp.ph, a.quality ?? 0.85); }
        : kind === 'profile'
          ? async () => { const sub = Math.max(1, +a.sub || 1), p = await timed({ stats: true }, () => drafted(draft, () => render(t, sub, +a.shutter || 0, +a.fps || 60, null, false, 'accurate', clamp(a.scale, 0.1)))); return { t, samples: sub, size: [comp.pw, comp.ph], ...p }; }
          : null;
      if (!job) return reject(new Error(`the film draws no ${kind} for agents`));
      agentJobs.push({ job, resolve, reject }); kick();
    });
    // (a frame of the film as the cache keeps it, drawn here and whole: given to it, its pixels read back)
    async function keepIt(C, i, look, F) {
      const px = await comp.finish(finishOf(F), 0);
      if (px && frames.put(i, { data: px, w: comp.pw, h: comp.ph }, C.scale ?? 1, C.gen, C.key, look)) pv.kept.add(i);
    }
    // the cache's frames it does not have of the film as it is, while nothing else is drawn: outward from the playhead, two
    // ahead for each behind, a few sub-frames at a time (the next asked for meanwhile goes first; a frame of its own set
    // aside by another drawn is begun again); none while playing, with a change of the editor's under way, or Pre-render off
    // (idle work waits for the view to have been still a moment: none while the director scrubs, turns it or plays)
    const IDLE_MS = 500;
    let asked = 0, askedKey = '';
    const stillFor = () => performance.now() - asked;
    // (idle, first: the renderer's pipelines for every moment of the film made ready, without drawing, as a render worker's
    // are made before it draws (__warm), so that a frame met later does not wait for its shaders; a few moments at a time)
    const warmth = { key: '', t: 0, seen: new Set(), done: false };
    // (for the look the cache is filled in, Accurate, once for each version of the timeline's changes, whatever look is
    // shown meanwhile; a moment at a time, the page's other work between them: a film's code can take a good part of a
    // second for a moment, as spring-brutalist's, painting its screens)
    async function warm() {
      const key = JSON.stringify([overridesGen, film.duration]);
      if (warmth.key !== key) Object.assign(warmth, { key, t: 0, seen: new Set(), done: false });
      if (warmth.done || !film.duration) return false;
      comp.look = 'accurate';
      say('finishing getting its shaders ready');
      const sc = sceneAt(warmth.t), w = comp.wants(sc);
      if (!warmth.seen.has(w)) { warmth.seen.add(w); await comp.prepare(sc); }
      warmth.t += 0.25;
      if (warmth.t > film.duration) warmth.done = true;
      await new Promise((r) => setTimeout(r, 0));
      return true;
    }
    async function fill(s) {
      if (!s.playing) { await comp.reading?.catch(() => {}); await keepStill(); }
      if (s.playing || stillFor() < IDLE_MS) { if (!s.playing) setTimeout(kick, IDLE_MS - stillFor() + 10); return false; }
      if (await agentTurn(s)) return true;
      if (asking.length) return false;   // (a question about the film first: the idle work carries on after it, afterQuestions)
      const C = cacheOf(s);
      if (!C.ok || nudge || s.draft != null || s.look !== 'accurate' || !C.prerender || !frames.ready || !(C.samples > 0)) return false;
      if (await warm()) return true;
      const z8 = Math.round((C.scale ?? 1) * 8), f0 = Math.max(0, Math.round((s.t ?? 0) * C.fps));
      const free = (i) => i >= 0 && i < C.F && !pv.kept.has(i) && !(C.stateOf(i) >= 2 && C.sizeOf(i) >= z8);
      let P = pv.fill;
      if (P && (P.gen !== C.gen || P.draws !== draws || !free(P.f))) P = pv.fill = null;
      if (!P) {
        let next = null;
        for (let a = f0 + 1, b = f0 - 1; next == null && (a < C.F || b >= 0); b--) {
          for (let k = 0; k < 2 && a < C.F && next == null; k++, a++) if (free(a)) next = a;
          if (next == null && b >= 0 && free(b)) next = b;
        }
        if (next == null && free(f0)) next = f0;
        if (next == null) return false;
        P = pv.fill = { f: next, gen: C.gen, F: null, done: 0, draws: ++draws };
        say('finishing a frame it was pre-rendering');
        P.F = await render(next / C.fps, C.samples, C.shutter ?? 0.5, C.fps, null, false, 'accurate', C.scale ?? 1, { prepare: true, cap: Math.max(64, C.samples) });
        P.draws = ++draws;
        return true;
      }
      const end = performance.now() + 12;
      say('finishing a frame it was pre-rendering');
      do { await drawSub(P.F, P.done++); await dev.queue.onSubmittedWorkDone(); } while (P.done < P.F.sub && performance.now() < end && want === s);
      P.draws = ++draws;
      if (P.done >= P.F.sub) { await keepIt(C, P.f, 'accurate', P.F); pv.fill = null; }
      return true;
    }
    async function preview(s) {
      shownFr = null; place(s.place); layer.place(s.place); layer.show(true);
      const C = cacheOf(s), F = C.F, fps = C.fps, f = s.f, samples = C.samples ?? 1;
      // (a change the cache has not drawn: the gesture going on, the editor's draft; drawn now)
      const changed = !!nudge || s.draft != null || !C.ok;
      const current = (i) => { const c = frames.kept(i); return !changed && !!c && c.look === s.look && C.stateOf(i) >= 2 && c.state >= 2 && c.gen === C.gen && c.size === C.sizeOf(i); };
      frames.at(f, !!s.playing, !!s.every, s.playing ? f : f - 2, s.playing ? f + 11 : f + 2);
      if (!changed) for (const i of s.playing ? Array.from({ length: 12 }, (_, k) => f + k) : [f, f + 1, f - 1, f + 2, f - 2]) if (i >= 0 && i < F && C.stateOf(i) >= 2 && !current(i)) frames.want(i);
      const frameOf = (i) => ({ t: i / fps, camera: filmCam(i / fps), gen: overridesGen, draft: s.draft, film: true });
      // (a frame of the cache's, as it is kept once what goes over it is found: one dropped meanwhile is asked for again)
      const show = async (i) => {
        const fr = frameOf(i); await layer.prepare(fr);
        const c = frames.kept(i);
        if (!c) return false;
        await presentBitmap(c.bmp); layer.drawn(fr); pv.f = i; pv.shownDone = samples;
        tell('shown', { camera: fr.camera, t: fr.t, f: i, done: samples, sub: samples, cached: true, ...(s.stats && c.profile && { profile: c.profile }) });
        return true;
      };
      const drawn = async (i, sub) => {
        const fr = frameOf(i); await layer.prepare(fr); draws++;
        const profile = await timed(s, () => drafted(s.draft, () => render(fr.t, sub, sub > 1 ? C.shutter ?? 0.5 : 0, fps, null, false, s.look ?? 'accurate', C.scale ?? 1, { present: shown, said: saying(s) })));
        presented(); layer.drawn(fr); pv.f = i; pv.shownDone = sub;
        tell('shown', { camera: fr.camera, t: fr.t, f: i, done: sub, sub, ...(profile && { profile }) });
      };
      // (a frame drawn whole as the cache draws its frames, its samples and shutter, shown, and given to the cache where it is
      // the film as the cache keeps it)
      const whole = async (i) => {
        const fr = frameOf(i); await layer.prepare(fr); draws++;
        let W = null;
        const profile = await timed(s, () => drafted(s.draft, async () => {
          W = await render(fr.t, samples, C.shutter ?? 0.5, fps, null, false, s.look ?? 'accurate', C.scale ?? 1, { prepare: true, cap: Math.max(64, samples), said: saying(s) });
          for (let k = 0; k < W.sub; k++) await drawSub(W, k);
          await comp.finish(finishOf(W), 0, shown);
        }));
        presented(); layer.drawn(fr); pv.f = i; pv.base = 'whole'; pv.shownDone = W.sub;
        tell('shown', { camera: fr.camera, t: fr.t, f: i, done: W.sub, sub: W.sub, ...(profile && { profile }) });
        if (!changed) await keepIt(C, i, s.look ?? 'accurate', W);
      };
      // Playing: the playhead's frame from the cache, where it has it as the film is now; where it does not, drawn here as
      // the cache draws its frames and given to it, so that what is played is kept, as After Effects' preview keeps it (the
      // stretch it lacks plays as fast as its frames are drawn: dropping frames, the playhead's frame once the one before
      // is done; every frame, each, the editor waiting for it). Never a quicker frame than the cache's.
      if (s.playing) {
        rest = null; pv.key = ''; pv.stage = '';
        if (current(f)) { if (f !== pv.f || pv.base !== 'cache') { pv.base = 'cache'; await show(f); } return false; }
        // (the cache's frame on its way: a moment's wait for it, the newest of its frames before it shown meanwhile, never
        // one before that shown; then drawn, as a frame the cache has none of is)
        if (!changed && C.stateOf(f) >= 2) {
          if (pv.playWait?.f !== f) pv.playWait = { f, at: performance.now() };
          if (performance.now() - pv.playWait.at < 400) {
            let k = null;
            for (let i = f - 1; k == null && i >= Math.max(0, f - 24) && i > (pv.f != null && pv.f <= f ? pv.f - 1 : -1); i--) if (current(i)) k = i;
            if (k != null && (k !== pv.f || pv.base !== 'cache')) { pv.base = 'cache'; await show(k); }
            setTimeout(kick, 50);
            return false;
          }
        }
        if (pv.f === f && pv.base === 'whole') return false;
        await whole(f);
        return true;
      }
      // (the cache's frame coming back of one given it from here is the same frame: drawn on as it was)
      const c = frames.kept(f), key = JSON.stringify([f, s.look, C.scale, s.draft ?? null, overridesGen, nudgeKey, current(f) && !pv.kept.has(f) ? [c.gen, c.state, c.size] : null]);
      if (key !== pv.key) {
        rest = null;
        if (current(f)) { pv.base = 'cache'; pv.stage = 'beyond'; if (await show(f)) pv.key = key; return true; }
        // (the cache's frame on its way: waited for a moment, rather than drawing what it will show)
        if (!changed && C.stateOf(f) >= 2) { if (!pv.waited) pv.waited = performance.now(); if (performance.now() - pv.waited < 400) { say('waiting for its frame from the cache'); setTimeout(kick, 50); return false; } }
        pv.waited = 0; pv.key = key; pv.base = 'live'; pv.stage = 'samples';
        await drawn(f, 1);
        await dev.queue.onSubmittedWorkDone();
        return true;
      }
      pv.waited = 0;
      if (await agentTurn(s)) return true;
      // (on to the cache's samples, each sub-frame shown, and given to the cache whole where it is the film as the cache
      // keeps it; then, Converge on, past them, shown once it has more)
      const stage = pv.stage, n = stage === 'samples' ? samples : s.n ?? 0;
      if (stage !== 'samples' && !(n > samples)) { pv.stage = 'done'; return fill(s); }
      if (!rest) { draws++; rest = { F: await render(f / fps, n, C.shutter ?? 0.5, fps, null, false, s.look ?? 'accurate', C.scale ?? 1, { prepare: true, cap: Math.max(64, n) }), done: 0 }; }
      if (want !== s) return true;
      if (rest.done < rest.F.sub) {
        const end = performance.now() + 12;
        do { draws++; await drawSub(rest.F, rest.done++); await dev.queue.onSubmittedWorkDone(); } while (rest.done < rest.F.sub && performance.now() < end && want === s);
        if ((stage === 'samples' || rest.done > samples) && rest.done > pv.shownDone) {
          await comp.finish(finishOf(rest.F), rest.done < rest.F.sub ? rest.F.sub / rest.done : 0, shown);
          presented(); pv.shownDone = rest.done;
          tell('shown', { camera: filmCam(f / fps), t: f / fps, f, done: rest.done, sub: rest.F.sub });
        }
        if (rest.done < rest.F.sub) { await new Promise((r) => requestAnimationFrame(r)); return true; }
      }
      if (stage === 'samples') {
        if (!changed) await keepIt(C, f, s.look ?? 'accurate', rest.F);
        rest = null; pv.stage = 'beyond';
        return true;
      }
      pv.stage = 'done';
      return fill(s);
    }
    async function viewer() {
      drawing = true;
      try {
        for (;;) {
          const s = want;
          if (lost) return;   // (the film is loaded again: this page shows what it kept meanwhile)
          // (another view: drawn from the start, nothing of the last one's carried over)
          if (s?.view !== lastView) { rest = null; shownKey = ''; pv.key = ''; pv.f = null; lastView = s?.view; frameWas = null; }
          // (the studio's cache, read and given frames here in either view)
          if (s?.cache?.studio) { frames.use(s.cache.studio); frames.view(s.place ? Math.round(s.place.width * (s.dpr ?? devicePixelRatio)) : 0, s.place ? Math.round(s.place.height * (s.dpr ?? devicePixelRatio)) : 0, s.cache.scale ?? 1); frames.stats(!!s.stats); }
          if (s?.view === 'film') { if (await preview(s)) continue; return; }
          if (!s || s.view !== 'director') { screen.style.display = 'none'; layer.show(false); rest = null; shownKey = ''; pv.key = ''; if (await agentTurn(s)) continue; return; }
          const fr = s.camera === 'film' ? null : frameNow(s);
          placeShown(s.place); layer.place(s.place); layer.show(true);
          const cam = s.camera === 'film' ? filmCam(s.t) : s.camera;
          const key = JSON.stringify([s.t, cam, s.look, s.scale, fr, s.draft ?? null, overridesGen, nudgeKey]);
          if (key !== shownKey) {
            rest = null;
            const f = { t: s.t, camera: cam, gen: overridesGen, draft: s.draft, film: false };
            await layer.prepare(f);
            draws++;
            const profile = await timed(s, () => drafted(s.draft, async () => { await render(s.t, 1, 0, 60, cam, !!s.playing, s.look ?? 'accurate', s.scale ?? 1, { present: shown, frame: fr, said: saying(s) }); shownFr = fr; placeShown(s.place); }));
            presented();
            layer.drawn(f);
            shownKey = key; shownDone = 1;
            tell('shown', { camera: cam, t: s.t, done: 1, sub: 1, ...(profile && { profile }) });
            await dev.queue.onSubmittedWorkDone();
            continue;
          }
          if (await agentTurn(s)) continue;
          // (at rest: drawn on while nothing else is asked, until all n are drawn; then the cache filled)
          if (s.playing || !(s.n > 1)) { if (await fill(s)) continue; return; }
          if (!rest) { draws++; rest = { F: await render(s.t, s.n, s.shutter ?? 0, s.fps ?? 60, cam, false, s.look ?? 'accurate', s.scale ?? 1, { prepare: true, cap: Math.max(64, s.n), frame: fr }), done: 0 }; }
          if (want !== s) continue;
          if (rest.done >= rest.F.sub) { if (await fill(s)) continue; return; }
          const end = performance.now() + 12;
          do { draws++; await drawSub(rest.F, rest.done++); await dev.queue.onSubmittedWorkDone(); } while (rest.done < rest.F.sub && performance.now() < end && want === s);
          if (rest.done > shownDone) {
            await comp.finish(finishOf(rest.F), rest.done < rest.F.sub ? rest.F.sub / rest.done : 0, shown);
            presented(); shownDone = rest.done;
            tell('shown', { camera: cam, t: s.t, done: rest.done, sub: rest.F.sub });
          }
          // (a step at most each frame the screen shows: a frame the canvas is given sooner is never seen)
          await new Promise((r) => requestAnimationFrame(r));
        }
      } catch (e) { tell('failed', { error: String(e?.message ?? e) }); shownKey = ''; }
      finally { drawing = false; }
    }
    parent.postMessage({ ephemeris: 'viewport-ready', duration: film.duration, size: [W, H], cuts, cues: window.__cueRefs, shaders: window.__shaders }, '*');
  }
}
// The ring of images the editor's window shares with the viewport's render process (app/frames.cjs, through this page's
// preload, app/viewport-preload.cjs: bridge), as what a frame is drawn onto (render/index.js endFrame): acquire(w, h),
// the next image free (a ring of that size made first where the size changed); submitted(), its copy sent, the image
// told to the editor once the GPU has done it; shown(meta, fr), what that frame shows, sent with it, and overlay: what
// goes over it, found for it. The editor lets an image go once it has drawn it; one it never answers for is taken back.
function ringOf(dev, bridge) {
  const R = { id: null, w: 0, h: 0, frames: [], free: [], inflight: [], wait: [], tex: null, cur: null, last: null, making: null, got: new Map() };
  bridge.onTexture((imported, a) => {
    if (!R.got.has(a.ring)) R.got.set(a.ring, []);
    R.got.get(a.ring)[a.k] = imported.getVideoFrame();
  });
  bridge.onFree((ring, k) => {
    if (ring !== R.id) return;
    const i = R.inflight.indexOf(k);
    if (i >= 0) R.inflight.splice(i, 1);
    if (!R.free.includes(k)) R.free.push(k);
    R.wait.shift()?.();
  });
  async function resize(w, h) {
    const { id, n } = await bridge.ring(w, h);
    const got = R.got.get(id) ?? [];
    for (const f of R.frames) f?.close();
    for (const [other, fs] of R.got) if (other !== id) { for (const f of fs) f?.close(); R.got.delete(other); }
    R.got.delete(id);
    Object.assign(R, { id, w, h, frames: got, free: [...Array(n).keys()].filter((k) => got[k]), inflight: [] });
    for (const wake of R.wait.splice(0)) wake();
  }
  let overlay = null;
  return {
    canvas: { width: 0, height: 0 },
    set overlay(o) { overlay = o; },
    async acquire(w, h) {
      for (;;) {
        if (w !== R.w || h !== R.h) { await (R.making ??= resize(w, h).finally(() => { R.making = null; })); continue; }
        if (R.free.length) break;
        let timer;
        const taken = await Promise.race([new Promise((r) => R.wait.push(() => r(false))), new Promise((r) => { timer = setTimeout(() => r(true), 1500); })]);
        clearTimeout(timer);
        // (one the editor never answered for, its window gone a while, say: taken back, the oldest)
        if (taken && !R.free.length && R.inflight.length && w === R.w && h === R.h) R.free.push(R.inflight.shift());
      }
      const k = R.free.shift();
      R.cur = { k, ring: R.id };
      R.tex = dev.importSharedTexture(R.frames[k], GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT);
      return R.tex;
    },
    submitted() {
      const tex = R.tex, cur = R.cur;
      R.tex = R.cur = null;
      tex?.destroy();
      if (!cur) return;
      const P = { ring: cur.ring, k: cur.k, w: R.w, h: R.h, shown: null, overlay: null, fr: null, sent: false };
      R.inflight.push(cur.k);
      R.last = P;
      dev.queue.onSubmittedWorkDone().then(() => { P.sent = true; bridge.frame(P); }, () => {});
    },
    shown(meta, fr) {
      const P = R.last, o = overlay;
      overlay = null;
      if (P && !P.sent) Object.assign(P, { shown: meta, overlay: o, fr });
      else bridge.frame({ ring: null, shown: meta, overlay: o, fr });   // (told after its picture went: on its own)
    },
  };
}

// the plain properties of a placed thing the editor's lanes show
const PLACED = ['x', 'y', 'z', 'rx', 'ry', 'rz', 's'];
const PLACED_AXES = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
// (a pass's: its params that are numbers, and each part of its vectors)
const numericParams = (n) => editable(n.params);
const MATERIAL = ['metallic', 'roughness', 'ior', 'transmissionWeight', 'coatWeight', 'sheenWeight', 'emissionStrength', 'iridescence', 'dispersion', 'thinFilmThickness'];

// the editor's picking (see window.__pick): the scene at t as drawn from `camera` (or the film's), each node with where
// the film's code placed it (its call stack, taken only now: it costs)
function traced(sceneAt, t, camera) {
  const was = globalThis.__sites;
  globalThis.__sites = true;
  try { const s = sceneAt(t); return camera ? { ...s, camera, nodes: s.nodes.filter((n) => n && !n.screen) } : s; }
  finally { globalThis.__sites = was; }
}
// which of its call's nodes each node is (as overrides number them: a node split off for a material keeps its own)
function nthsOf(nodes) {
  const seen = new Map();
  return nodes.map((n) => {
    const at = n && siteOf(n.site)?.at;
    if (!at) return -1;
    if (n.nth != null) return n.nth;
    seen.set(at, (seen.get(at) ?? -1) + 1);
    return seen.get(at);
  });
}
// what an object is called, from what its things are (a loop's "beam 1", "beam 2"…: "beam"): the one they share, or
// the start they share, or the first
function commonLabel(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  let p = labels[0];
  for (const l of labels) while (!l.startsWith(p)) p = p.slice(0, -1);
  p = p.replace(/[\s\d#:._-]+$/, '');
  return p.length >= 3 ? p : labels[0];
}
// a node as the editor shows it: what it is, where the film placed and made it, where it is and how it looks, its
// outline on the frame
function describe(s, i, copy, camera, point = null) {
  const n = s.nodes[i], site = siteOf(n.site), it = n.instances?.[copy], orig = it?.__orig ?? it;
  const hex = (c) => '#' + c.map((v) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0')).join('');
  const m = n.material, look = (m) => ({ baseColor: hex(m.baseColor), metallic: m.metallic, roughness: m.roughness, ior: m.ior, transmissionWeight: m.transmissionWeight,
    coatWeight: m.coatWeight, sheenWeight: m.sheenWeight, emissionStrength: Math.max(...m.emission) > 0 ? +Math.max(...m.emission).toFixed(3) : 0,
    thinFilmThickness: m.thinFilmThickness, iridescence: m.iridescence, dispersion: m.dispersion,
    ...(n.mesh?.normalMap && !m.glass && { normalStrength: m.normalStrength }) });   // (only where it bends something)
  return {
    kind: n.mesh ? (m.glass ? 'glass' : 'mesh') : n.pass ? 'pass' : n.light ? 'light' : n.screen ? 'title' : 'layer',
    label: n.label || n.layer?.label || n.mesh?.label || '',
    copy, copies: n.instances?.length ?? 0,
    at: site?.at ?? null, file: site?.file ?? null, line: site?.line ?? null, clip: site?.clip ?? null, added: !!site?.added,
    nth: site ? nthsOf(s.nodes)[i] : 0,
    // which copy, to find it again: its id, or its fields as the code placed it; and what overrides changed now
    key: orig?.id ?? orig?.key ?? null, like: orig ? fieldsOf(orig) : null,
    applied: (it ?? n).__applied ?? null, override: (it ?? n).__override ?? null,
    made: siteOf((n.mesh ?? n.layer ?? n.of)?.site),
    where: it ? { x: it.x, y: it.y, z: it.z, rx: it.rx, ry: it.ry, rz: it.rz, s: it.s, baseColor: it.baseColor, ...(n.added && { sx: Array.isArray(it.s) ? it.s[0] : it.s ?? 1, sy: Array.isArray(it.s) ? it.s[1] : it.s ?? 1, sz: Array.isArray(it.s) ? it.s[2] : it.s ?? 1 }) }
      : n.light ? { x: n.x, y: n.y, z: n.z ?? 0, rx: n.rx ?? 0, ry: n.ry ?? 0, rz: n.rz ?? 0, intensity: n.intensity, radius: n.radius, angle: n.angle, soft: n.soft, range: n.range, shadows: n.shadows === true, color: n.color, type: n.light }
      : n.pass ? { ...(n.pass.bounds && { x: n.x, y: n.y, z: n.z, rx: n.rx, ry: n.ry, rz: n.rz, s: n.s }), stage: n.pass.stage, params: n.params, ranges: n.pass.ranges }
      : { x: n.x, y: n.y, z: n.z, rx: n.rx, ry: n.ry, rz: n.rz, w: n.w, h: n.h, opacity: n.opacity },
    // its material; and the code's values (opacity, material) where an override replaced them
    material: m && look(m), surface: n.surface ? { label: n.surface.of.label, mode: n.surface.of.mode, params: n.surface.params, ranges: n.surface.of.ranges } : null, code: n.__code || it?.__code ? { ...(n.__code ? (n.mesh ? look(n.__code) : n.__code) : {}), ...(it?.__code ?? {}) } : null,
    // (and its corners in the world, for the editor to move with a drag of its own: null on the screen)
    point, outline: outline(n, copy, camera ?? s.camera), box: corners(n, copy),
  };
}

// a point on the unit disk from two uniform numbers (concentric mapping: evenly spread, no clumping at the centre)
function disk(u, v) {
  const a = 2 * u - 1, b = 2 * v - 1;
  if (!a && !b) return [0, 0];
  const [r, th] = Math.abs(a) > Math.abs(b) ? [a, (Math.PI / 4) * (b / a)] : [b, Math.PI / 2 - (Math.PI / 4) * (a / b)];
  return [r * Math.cos(th), r * Math.sin(th)];
}
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

// ---------- the timeline's own visuals: its visual tracks' clips (images and videos, brought in by the assets panel:
// nle/model.js), each a layer of its own drawing its picture, placed in the world where the clip starts (see placeClip
// in boot): a card under the film's camera that then moves as the world does (parallax as the camera drifts, motion
// blur, seen in glass), changed as any placed thing is (its site: clip:<id>). Later tracks draw over earlier ones. A
// video shows its frame for the moment, decoded beforehand (tools/media.mjs), never a <video> seeking near it.
function timelineClips(host, layers, tl) {
  const out = [];
  for (const tr of tl?.tracks ?? []) {
    if (tr.kind !== 'visual') continue;
    for (const c of tr.clips) {
      const m = tl.media?.[c.media];
      if (!m?.w || !m.h || (m.kind !== 'image' && m.kind !== 'video')) continue;
      const video = m.kind === 'video', end = c.at + (c.out - c.in) / (c.speed || 1), img = new Image();
      img.alt = ''; Object.assign(img.style, { display: 'block', width: '100%', height: '100%' });
      img.src = new URL(video ? frameSrc(m, 0) : m.src, location.href).href;
      const L = new Layer(host, img, { w: m.w, h: m.h, pad: 2, res: Math.min(1, 2560 / Math.max(m.w, m.h)), live: video ? [c.at, end] : false, label: m.name ?? c.media });
      layers.push(L);
      out.push({ c, m, L, img, end, video, site: { at: `clip:${c.id}`, file: null, line: null, col: null, clip: c.id } });
    }
  }
  return out;
}
const frameSrc = (m, k) => `${m.frames}/${String(k + 1).padStart(6, '0')}.jpg`;
// each video clip's picture: its frame at t (outside the clip, its nearest end's, as a live layer is held there), loaded
function clipFrames(clips, t) {
  const waits = [];
  for (const k of clips) {
    if (!k.video) continue;
    const tt = Math.min(Math.max(t, k.c.at), k.end - 1e-6), last = Math.max(0, Math.round((k.m.duration ?? 1e9) * k.m.fps) - 1);
    const i = Math.max(0, Math.min(last, Math.floor(((tt - k.c.at) * (k.c.speed || 1) + k.c.in) * k.m.fps + 1e-6)));
    const src = new URL(frameSrc(k.m, i), location.href).href;
    if (k.img.src !== src) { k.img.src = src; k.L.invalidate(); waits.push(new Promise((r) => { k.img.onload = k.img.onerror = r; })); }
  }
  return waits.length ? Promise.all(waits) : null;
}
// a clip as a node of the scene, where it sits
function clipNode(k, p) { return { ...k.L.at(p.x, p.y, { z: p.z, rx: p.rx, ry: p.ry, rz: p.rz, s: p.s }), label: k.L.label, site: k.site }; }

// What this page's shaders are made from, as a fingerprint: the film's own WGSL (its surfaces and its passes, each with
// what it puts in its shader: its params' struct, its pictures), its frame, the page's settings (?gi=, ?rendering=…)
// and the GPU. A worker whose browser already made a page of the same fingerprint ready has every shader it needs
// (tools/preview.mjs), so a page loaded again for its timeline alone is not made ready again. Ephemeris's own shaders
// are the studio's to fingerprint: they are its files. A film with a renderer of its own (render: its passes, its
// shaders' parts, their WGSL anywhere in their modules) has none, and is made ready each time, as any was before.
async function shaderSet(adapter, dev, film, passes) {
  if (film.render) return null;
  const pictures = (ts) => Object.entries(ts ?? {}).map(([k, t]) => [k, t.constructor.name, t.format ?? null]);
  const page = new URLSearchParams(location.search);
  for (const k of ['ws', 'timeline']) page.delete(k);
  page.sort();
  const { vendor, architecture, device, description } = adapter.info ?? {};
  const text = JSON.stringify([
    everySurface.map((S) => [S.code, S.mode, S.layout.struct, pictures(S.textures)]),
    passes.map((P) => [P.code, P.stage, P.layout.struct, pictures(P.textures), P.target?.format ?? null, P.once]),
    [W, H], page.toString(), [vendor, architecture, device, description, hasRays(dev)],
  ]);
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
