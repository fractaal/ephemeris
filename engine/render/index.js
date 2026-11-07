// The renderer: a film's scene, sub-frame by sub-frame, into its frame. It keeps one scene for every pass (shaders.js:
// the camera, the world, the scene's tables, the geometry, the texture store), runs the frame's passes in order
// (graph.js; passes/), and gives the editor what it asks of a renderer: renderSub (a sub-frame, added into the frame
// with its weight), finish (the frame's passes, its pixels), resize (the size drawn), look (how a preview draws),
// allocLayer and buildMips (a layer's captured picture).
//
// Light is linear and scene-referred from the shaders to the frame's light, which the sub-frames add up (motion blur,
// antialiasing, depth of field average light, as a camera does); the view transform makes it the frame as seen, once,
// at the end, and the layers as authored are put over it there, as they were drawn.
import { hasRays, hardwareTrace, raysLayout, withRays, HardwareScene } from './rays.js';
import { used } from './used.js';
import { W, H } from '../camera.js';
import { INSTANCE_FLOATS } from '../mesh.js';
import { COMMON, SCENE, BSDF, LIGHTING, SURFACE, WORLD_FLOATS } from './shaders.js';
import { TRACE, AROUND_ENV } from './trace.js';
import { surfacesWGSL } from './surfaces.js';
import { TextureStore } from './textures.js';
import { GeometryStore, VERTEX_LAYOUT } from './geometry.js';
import { FrameTextures, assemble } from './graph.js';
import { cameraData, worldData, tablesData, renewTree, instancesData, copyBoxes, shutterBoxes, surfacesData, lightsOf, axes } from './scene.js';
import { matte } from './materials.js';
import { cull } from './passes/cull.js';
import { prepass, opaque } from './passes/meshes.js';
import { shadows } from './passes/shadows.js';
import { ao } from './passes/ao.js';
import { gi } from './passes/gi.js';
import { denoise } from './passes/denoise.js';
import { EMITTERS, emittersData } from './emitters.js';
import { layers } from './passes/layers.js';
import { glass } from './passes/glass.js';
import { resolve } from './passes/resolve.js';
import { bloom, view, output } from './passes/post.js';
import { filmPasses, pickPass } from './passes/film.js';
import { wire } from './passes/wire.js';
import { createProfiler } from './profile.js';
import { drawLevels, levelsReady } from './levels.js';

// the longest a sub-frame's heavy passes hold the GPU at a time, in ms: the GPU turns to other programs (the desktop
// drawing its next frame) only between submissions, so longer ones make it stutter. How long a sub-frame holds it is
// timed on the GPU's side (from its work beginning to queue.onSubmittedWorkDone), not the page's: a sub-frame's scene
// data, made while the GPU draws the one before, is no part of it, and bands it does not need cost what a band draws
// again (the copies across a band's edge, each band's own passes)
const CHUNK_MS = 4;
/**
 * How the studio's previews may draw a frame (Blender's viewport shading): 'accurate' (as the film renders: masters and
 * drafts are always this); 'fast' (nothing traced, one sub-frame); 'solid' (every mesh in its own colour, matte, lit by
 * a plain studio; layers as authored); 'wire' (meshes' edges and layers' outlines).
 */
export const LOOKS = ['accurate', 'fast', 'solid', 'wire'];
/**
 * The WGSL every shader that shades or traces starts with (R.prelude()), in parts a film may replace with its own (its
 * render.lib: a part taken with ./ephemeris take and changed): a BSDF of its own is then the one the camera, reflections,
 * GI and glass all shade with.
 */
export const LIB = { COMMON, SCENE, BSDF, LIGHTING, SURFACE, TRACE, EMITTERS };
/**
 * The studio's passes, in order. A film's render.passes is its own list (this one with a pass replaced, one of its own
 * put in): put together when the film starts, and an error there names what a pass reads that none before it writes.
 */
export const PASSES = [cull, prepass, shadows, ao, gi, opaque, denoise, filmPasses('scene'), layers, glass, resolve, filmPasses('light'), bloom, view, filmPasses('display'), output];

const STUDIO = { zenith: '#e2e5ea', horizon: '#a7a9ae', nadir: '#4c4e53', intensity: 0.75 };
const STUDIO_LIGHTS = [{ light: 'sun', dir: [0.55, 1, -0.75], intensity: 1.15, angle: 40 }, { light: 'sun', dir: [-0.85, 0.25, -0.55], intensity: 0.35, angle: 60 }];

export class Renderer {
  /**
   * @param {GPUDevice} dev
   * @param {{ gi?: boolean | null, shadows?: boolean | null, reflections?: boolean | null, rendering?: object,
   *   render?: { passes?: object[], lib?: object } }} o where the timeline sets them for the whole film (null: as its
   *   scenes and lights ask): global illumination in every scene or none, traced shadows from every light or none,
   *   traced reflections in every scene or none; how they are traced (rendering: { gi, shadows, reflections, glass },
   *   each's fields over the scene's own, glass's over each glass's: nle/model.js); and the film's own renderer (its
   *   render: see LIB, PASSES)
   */
  constructor(dev, { gi = null, shadows = null, reflections = null, rendering = {}, render = {}, surfaces = [] } = {}) {
    this.dev = dev;
    this.made = new Map();   // (its pipelines, by key: promises of them, see pipeline)
    this.asked = 0;   // (how many pipelines it has asked to be made: see prepare)
    this.busy = Promise.resolve();   // (what it is drawing now: see exclusive)
    this.everySurface = surfaces;
    this.giAll = gi; this.shadowsAll = shadows; this.reflectionsAll = reflections; this.rendering = rendering;
    this.look = 'accurate';
    this.frameInfo = { frame: 0, fps: 60 };
    this.bands = 8; this.frame = null;
    this.prof = createProfiler(dev);   // (what a frame took, when one asks: the studio's profiler)
    // (room in the opaque pass for what it keeps for the denoiser: 80 bytes a pixel, where the default is 32; runtime.js
    // asks for the adapter's most)
    this.canDenoise = dev.limits.maxColorAttachmentBytesPerSample >= 80;
    this.textures = new TextureStore(dev);
    this.geometry = new GeometryStore(dev);
    this.tex = new FrameTextures(dev);
    this.linear = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const B = GPUBufferUsage, FC = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, ro = { type: 'read-only-storage' };
    this.camBuf = dev.createBuffer({ size: 96, usage: B.UNIFORM | B.COPY_DST });
    this.worldBuf = dev.createBuffer({ size: WORLD_FLOATS * 4, usage: B.UNIFORM | B.COPY_DST });
    this.bufs = {};
    this.layouts = {
      frame: dev.createBindGroupLayout({ entries: [0, 1].map((binding) => ({ binding, visibility: GPUShaderStage.VERTEX | FC, buffer: {} })) }),
      scene: dev.createBindGroupLayout({ entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: FC, buffer: ro })).concat(TextureStore.layout(4, FC), hasRays(dev) ? [raysLayout(FC)] : []) }),
    };
    this.frameBG = dev.createBindGroup({ layout: this.layouts.frame, entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: { buffer: this.worldBuf } }] });
    this.vertexLayout = VERTEX_LAYOUT(INSTANCE_FLOATS);
    for (const k of Object.keys(render.lib ?? {})) if (!(k in LIB)) throw new Error(`a film's render.lib replaces some of ${Object.keys(LIB).join(', ')} (not "${k}")`);
    this.lib = { ...LIB, ...render.lib };
    if (hasRays(dev)) { this.lib.TRACE = hardwareTrace(this.lib.TRACE); this.rays = new HardwareScene(dev); }
    const passes = render.passes ?? PASSES;
    this.passes = assemble(passes);
    // (the Wire look draws the frame's light itself; the frame's own passes then see it as any frame)
    this.wirePasses = assemble([wire, ...passes.filter((p) => p.stage === 'frame')]);
    this.surfaceKey = '';
    this.resize(1);
    for (const p of new Set([...this.passes, ...this.wirePasses])) p.setup(this);
    // (a layer's picture premultiplied, a frame so far scaled, the levels of pictures: made with the passes' own)
    this.pipeline('layer picture', () => this.premulDesc()).then((p) => { this.premul ??= p; }, () => {});
    this.pipeline('a frame so far', () => this.scalerDesc()).then((p) => { this.scaler ??= p; }, () => {});
    this.levelsReady = Promise.all([this.textures.ready, levelsReady(dev, [['box', 'rgba8unorm'], ['box', 'rgba8unorm-srgb'], ['box', 'rgba16float'], ['soft', 'rgba16float']])]);
  }

  /**
   * A pipeline, made once for its key and away from the GPU process's main thread (createRenderPipelineAsync): a promise
   * of it, which a pass awaits before it records what draws with it. Made synchronously, a heavy shader holds that thread
   * for seconds, and every page of the browser with it: the studio's window, where the viewer draws the film, freezes.
   * desc() makes its descriptor (the first time only); compute: a compute pipeline. A key names everything its descriptor
   * is made from that can change while the film runs (the film's surfaces: surfaceKey, a pass's variant).
   */
  pipeline(key, desc, compute = false) {
    let p = this.made.get(key);
    if (!p) {
      p = this.dev[compute ? 'createComputePipelineAsync' : 'createRenderPipelineAsync'](desc());
      this.made.set(key, p); this.asked++;
      p.catch(() => { if (this.made.get(key) === p) this.made.delete(key); });   // (one that failed is made again when next asked)
    }
    return p;
  }
  /** Every pipeline asked for so far, made: the passes' own, as they were set up, and the pictures'. */
  ready() { return Promise.all([...this.made.values(), this.levelsReady]); }
  // One sub-frame, a frame's end or a film pass's pick at a time: each writes the renderer's own buffers and records into
  // its encoder, and may wait for a pipeline as it goes, when something else could otherwise write them under it.
  exclusive(fn) { const run = this.busy.then(fn); this.busy = run.catch(() => {}); return run; }

  /** A shader module of the renderer's (only what its entry points use: used.js), an error in it said with its label and line. */
  module(src, label) {
    const mod = this.dev.createShaderModule({ code: withRays(used(src)), label });
    mod.getCompilationInfo().then((info) => {
      const lines = src.split('\n');
      for (const m of info.messages) if (m.type === 'error') console.error(`[render: ${label}] ${m.message} (line ${m.lineNum}: ${(lines[m.lineNum - 1] ?? '').trim()})`);
    });
    return mod;
  }
  pipelineLayout(groups) { return this.dev.createPipelineLayout({ bindGroupLayouts: groups }); }
  /**
   * The WGSL every shader that shades or traces starts with: the scene, with this sub-frame's surfaces compiled in; and
   * around, the light around what its rays meet (AROUND_ENV: the environment's; aroundGI: what GI found).
   */
  prelude(around = AROUND_ENV) { const L = this.lib; return L.COMMON + L.SCENE(surfacesWGSL(this.surfaces ?? [])) + L.BSDF + L.LIGHTING + L.SURFACE + L.TRACE + L.EMITTERS + around; }
  view(name) { return this.tex[name].createView(); }
  clear(name, value = [0, 0, 0, 0]) { return { view: this.view(name), loadOp: 'clear', storeOp: 'store', clearValue: value }; }
  load(name) { return { view: this.view(name), loadOp: 'load', storeOp: 'store' }; }
  // a band of the frame's rows, of the heavy passes' bands (each sent on its own: the same pixels however many)
  band(pass, b) { const y0 = Math.floor((b * this.ph) / this.bands), y1 = Math.floor(((b + 1) * this.ph) / this.bands); pass.setScissorRect(0, y0, this.pw, y1 - y0); }
  cut() { this.sent ??= performance.now(); this.dev.queue.submit([this.enc.finish()]); this.enc = this.dev.createCommandEncoder(); }
  /**
   * Draws mesh nodes (their indices in the sub-frame's meshes) from the geometry: the copies the cull pass kept (the
   * frame's, or band `band`'s in a pass drawn in bands), or, without one, every copy.
   */
  drawMeshes(pass, list, band = -1) {
    const G = this.geometry.buf, d = this.sub.draw;
    for (const i of list) {
      const n = this.sub.meshes[i], g = this.geometry.of(n.mesh.geo);
      const [first, count] = d ? (band < 0 ? d.all : d.bands[band] ?? d.all)[i] : [n.first, n.instances.length];
      if (!count) continue;
      pass.setVertexBuffer(0, G, g.vertex); pass.setVertexBuffer(1, d ? d.buf : this.bufs.inst); pass.setIndexBuffer(G, 'uint32', g.index);
      pass.drawIndexed(g.count, count, 0, 0, first);
    }
  }
  // a storage buffer of the scene's, at least as large as data (made larger as needed), with data in it (from: from that
  // number on, those before it there already)
  put(name, data, usage = 0, from = 0) {
    let b = this.bufs[name];
    if (!b || b.size < data.byteLength) {
      b?.destroy();
      b = this.bufs[name] = this.dev.createBuffer({ size: Math.max(256, data.byteLength * 2), label: name, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage });
      this.sceneBG = null;
      from = 0;
    }
    this.dev.queue.writeBuffer(b, from * data.BYTES_PER_ELEMENT, data, from);
  }

  /**
   * The size frames are drawn at: `scale` of the frame (1, a render; less, a preview the size of the editor's viewer),
   * its width a multiple of 64 px (the rows a readback copies). The same picture with fewer pixels: the camera and
   * everything placed keep the frame's px. The frame (fw × fh px, about the camera's centre) is the film's, or a view's
   * of its own shape (the editor's Director view, as its panel is: what the camera sees past the film's frame, or less of
   * it), nothing compiled again for it.
   */
  resize(scale = 1, [fw, fh] = [W, H]) {
    const pw = Math.max(64, Math.min(fw, Math.round((fw * scale) / 64) * 64)), ph = Math.max(1, Math.round((pw * fh) / fw));
    this.fw = fw; this.fh = fh; this.rs = pw / fw;
    if (pw === this.pw && ph === this.ph) return;
    this.pw = pw; this.ph = ph;
    this.tex.resize(pw, ph);
    this.out?.destroy();
    this.out = this.dev.createTexture({ size: [pw, ph], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.readBuf?.destroy();
    this.readRow = Math.ceil((pw * 4) / 256) * 256;
    this.readBuf = this.dev.createBuffer({ size: this.readRow * ph, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** A layer's picture, w x h device px: what it is captured into (straight alpha), and its picture as drawn (premultiplied, with mip levels). */
  allocLayer(w, h) {
    const dev = this.dev, levels = Math.max(1, Math.floor(Math.log2(Math.max(w, h))) - 2), U = GPUTextureUsage;
    const capture = dev.createTexture({ size: [w, h], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC | U.RENDER_ATTACHMENT });
    const sampled = dev.createTexture({ size: [w, h], format: 'rgba8unorm', mipLevelCount: levels, usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT });
    return { w, h, width: w, height: h, capture, sampled, levels: Array.from({ length: levels }, (_, i) => sampled.createView({ baseMipLevel: i, mipLevelCount: 1 })), view: sampled.createView(), version: 0 };
  }
  /** After a capture: premultiplied into level 0 (in sRGB, as browsers keep it), and its mip levels. */
  buildMips(L) {
    L.version++;
    const dev = this.dev;
    this.premul ??= dev.createRenderPipeline(this.premulDesc());   // (asked for before the one made ready in the constructor is)
    const enc = dev.createCommandEncoder();
    const r = enc.beginRenderPass({ colorAttachments: [{ view: L.levels[0], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    L.premulBG ??= dev.createBindGroup({ layout: this.premul.getBindGroupLayout(0), entries: [{ binding: 0, resource: L.capture.createView() }] });
    r.setPipeline(this.premul); r.setBindGroup(0, L.premulBG); r.draw(3); r.end();
    drawLevels(dev, enc, L.levels, 'rgba8unorm');
    dev.queue.submit([enc.finish()]);
  }

  premulDesc() {
    const mod = this.module(/* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0); }
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { let c = textureLoad(src, vec2i(p.xy), 0); return vec4f(c.rgb * c.a, c.a); }`, 'layer picture');
    return { layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } };
  }

  /**
   * What is traced in a scene, as it asks (traced light is asked for, never assumed), in the look that traces.
   */
  tracingOf(scene, meshes, lights) {
    const accurate = this.look === 'accurate', glass = meshes.some((n) => n.material.glass);
    const giAsked = this.giAll === null ? scene.gi : this.giAll && (scene.gi || true), solid = meshes.some((n) => !n.material.glass);
    const reflAsked = this.reflectionsAll === null ? scene.reflections : this.reflectionsAll && (scene.reflections || true);
    // (how each is traced: the scene's settings, the timeline's over them)
    const how = (own, k) => ({ ...(typeof own === 'object' ? own : {}), ...this.rendering[k] });
    const shadowsHow = how(scene.shadows, 'shadows'), reflHow = how(reflAsked, 'reflections');
    // (and denoised, by default, where the device has room for what the opaque pass keeps for it: meshes' traced shadows,
    // scene.shadows = { rays: a frame, 8; denoise }, and their traced reflections, scene.reflections = { denoise }; see
    // passes/denoise.js)
    const denoised = accurate && this.canDenoise && solid, reflect = accurate && reflAsked ? 1 : 0;
    const shadowRays = denoised && shadowsHow.denoise !== false && lights.some((L) => L.shadows) ? Math.max(1, shadowsHow.rays ?? 8) : 0;
    const reuse = denoised && reflect && reflHow.denoise !== false ? 1 : 0;
    const tracing = { shadowRays, keep: shadowRays || reuse ? 1 : 0, reuse, reflect, gi: accurate && giAsked && solid ? 1 : 0, ao: 0 };
    const traced = accurate && (lights.some((L) => L.shadows) || tracing.reflect || glass || tracing.gi);
    return { tracing, traced, giAsked, how };
  }
  /**
   * Which pipelines drawing a scene compiles: two scenes with the same answer draw with the same ones (a film asks this
   * of its moments, to make its shaders ready before it draws: runtime.js __warm). The film's own passes, by each one's
   * number here; what is traced; whether it has solid meshes, glass, layers, and lights with traced shadows.
   */
  wants(scene) {
    const meshes = scene.nodes.filter((n) => n?.mesh && n.instances?.length), lights = lightsOf(scene, this.shadowsAll), { tracing } = this.tracingOf(scene, meshes, lights);
    const ids = (this.passIds ??= new Map()), id = (P) => { if (!ids.has(P)) ids.set(P, ids.size); return ids.get(P); };
    return JSON.stringify([scene.nodes.filter((n) => n?.pass).map((n) => id(n.pass)).sort((a, b) => a - b), tracing.keep, tracing.reflect, tracing.gi, lights.some((L) => L.shadows),
      meshes.some((n) => !n.material.glass), meshes.some((n) => n.material.glass), scene.nodes.some((n) => n && (n.tex || n.fx) && (n.opacity ?? 1) > 0.001)]);
  }
  /**
   * One sub-frame of a scene into the frame with weight w. scene = { camera, t, environment, view, post, ao, gi,
   * reflections, shadows, nodes: [meshes, layers, effects, lights, passes] }. jitter: its offset (drawn px); lens: its
   * point on the lens (depth of field); phase: where it falls among the frame's sub-frames (0–1), so what is sampled
   * across them interleaves rather than repeats.
   */
  renderSub(scene, w, first, jitter, lens = [0, 0], phase = 0.5) { return this.exclusive(() => this.drawSub(scene, w, first, jitter, lens, phase)); }
  async drawSub(scene, w, first, jitter, lens, phase) {
    const dev = this.dev, look = this.look, accurate = look === 'accurate';
    if (look === 'solid') scene = solidScene(scene);
    if (look === 'wire') scene = { ...scene, view: {} };
    const began = performance.now();
    this.prof.at('scene data');
    if (first) this.frame = { began, subs: 0, gpu: 0, done: 0 };
    if (this.frame) this.frame.subs++;
    const meshes = scene.nodes.filter((n) => n?.mesh && n.instances?.length);
    const layers = scene.nodes.filter((n) => n && (n.tex || n.fx) && (n.opacity ?? 1) > 0.001);
    const world = layers.filter((n) => n.tex && !n.screen);
    this.useSurfaces(meshes);
    const lights = look === 'solid' ? STUDIO_LIGHTS.map((L) => ({ ...L, at: [0, 0, 0], dir: unit(L.dir), shadows: false })) : lightsOf(scene, this.shadowsAll);
    const glass = meshes.map((n, i) => (n.material.glass ? i : -1)).filter((i) => i >= 0);
    const { tracing, traced, giAsked, how } = this.tracingOf(scene, meshes, lights);
    if (traced) this.prof.say('rays', this.rays ? 'hardware' : 'software');
    const inst = instancesData(meshes);
    // (each copy's own index, which the camera's passes read from its data as they draw the copies the cull pass kept, and its node)
    meshes.forEach((n, i) => { for (let k = 0, o = n.first * INSTANCE_FLOATS; k < n.instances.length; k++, o += INSTANCE_FLOATS) { inst[o + 15] = n.first + k; inst[o + 27] = i; } });
    this.put('inst', inst, GPUBufferUsage.VERTEX);
    const boxes = scene.moments ? shutterBoxes(scene.moments, meshes) : copyBoxes(meshes, inst);
    // (held: its pictures as the frame's sub-frames before it took them, whatever their versions now: runtime.js drawSub)
    this.textures.hold = scene.held === true;
    let tables, data, from, sp;
    try {
      ({ tables, data, from } = tablesData(this, meshes, world, inst, boxes, traced, tracing.gi ? emittersData(meshes, world, inst, lights) : null));
      sp = surfacesData(this, meshes, scene.t ?? 0);
    } finally { this.textures.hold = false; }
    this.put('scn', data, 0, from);
    this.tables = tables;
    const accel = this.rays?.sync(this, meshes, inst);
    this.put('sp', sp);
    dev.queue.writeBuffer(this.worldBuf, 0, worldData(scene, lights, tables, tracing));
    const seed = (jitter[0] + 0.5) * 977 + (jitter[1] + 0.5) * 131 + lens[0] * 53 + lens[1] * 71;
    const cam = cameraData(this, scene.camera, jitter, lens, phase, w, seed);
    dev.queue.writeBuffer(this.camBuf, 0, cam.data);
    const gen = `${this.textures.gen}:${this.geometry.gen}:${this.rays?.gen}`;
    if (!this.sceneBG || this.sceneGen !== gen) {
      this.sceneGen = gen;
      this.sceneBG = dev.createBindGroup({ layout: this.layouts.scene, entries: [{ binding: 0, resource: { buffer: this.bufs.scn } }, { binding: 1, resource: { buffer: this.bufs.inst } },
        { binding: 2, resource: { buffer: this.geometry.buf } }, { binding: 3, resource: { buffer: this.bufs.sp } }, ...this.textures.entries(4), ...(accel ? [{ binding: 900, resource: accel }] : [])] });
    }
    const solids = meshes.map((n, i) => (n.material.glass ? -1 : i)).filter((i) => i >= 0);
    const aoOn = solids.length && scene.ao !== false && (!tracing.gi || scene.ao) && look !== 'wire';
    // (shadowed: some light's shadows are traced here, which the shadows pass finds for what the camera sees)
    this.sub = { scene, meshes, solids, glass, layers, world, weight: w, first, look, seed, inst, boxes, cam, shadowed: tables.traced > 0 && lights.some((L) => L.shadows),
      ao: aoOn ? { radius: 40, strength: 0.75, ...(typeof scene.ao === 'object' ? scene.ao : {}) } : null,
      gi: tracing.gi ? how(giAsked, 'gi') : null, reflect: tracing.reflect > 0, keep: tracing.keep > 0 };
    await this.prepare(this.sub);
    this.prof.add('Scene data', began);
    const recording = performance.now();
    this.enc = dev.createCommandEncoder(); this.sent = null;
    for (const p of look === 'wire' ? this.wirePasses : this.passes) if (p.stage === 'sub') { this.prof.at(p.name); await p.run(this, this.sub); }
    this.sent ??= performance.now();
    dev.queue.submit([this.enc.finish()]);
    this.prof.add('GPU commands', recording);
    // (how long the GPU spent on it: from its first work sent, or the sub-frame before it ending, to its last done)
    const F = this.frame, sent = this.sent;
    if (F) dev.queue.onSubmittedWorkDone().then(() => { const done = performance.now(); F.gpu += done - Math.max(sent, F.done); F.done = done; });
  }

  // the film's surfaces on meshes (not on glass): every one it has made, numbered in order, whichever this scene uses,
  // so that a shot with others does not compile every shader again (a worker reaching one of doctor-who's took 38 s);
  // and each mesh's (its number + 256 × its place, where its params are)
  useSurfaces(meshes) {
    const surfaces = this.everySurface;
    for (const n of meshes) if (n.surface && !n.material.glass && !surfaces.includes(n.surface.of)) surfaces.push(n.surface.of);
    meshes.forEach((n, i) => { n.spId = n.surface && !n.material.glass ? surfaces.indexOf(n.surface.of) + 1 + 256 * i : 0; });
    this.surfaces = surfaces; this.surfaceKey = surfaces.map((S) => S.id).join(',');
  }
  /**
   * The pipelines drawing a sub-frame will want of each pass, asked for now and all at once (each pass's want, where it
   * has one), so that they are made side by side rather than one after another as its passes reach them: a heavy film's
   * first frame with nothing in the caches made them for over a minute. A pass's guess, right, costs nothing; wrong, a
   * pipeline made that nothing draws with, or one made when its pass asks. sub: the sub-frame as drawSub has it, or a
   * scene alone, as a frame at that moment would draw it (__warm). Resolves once each is asked for, not made.
   */
  // (and where a pass asked for one, a moment before the next asks: their shaders' WGSL is parsed on the GPU process's main
  // thread as each is sent, one pass's at a time so that the studio's window draws between them, where all of a heavy
  // film's at once, 1.4 MB, held it for a second)
  async prepare(sub) {
    if (!sub.meshes) sub = this.planOf(sub);
    for (const p of sub.look === 'wire' ? this.wirePasses : this.passes) {
      const was = this.asked;
      p.want?.(this, sub);
      if (this.asked !== was) await new Promise((r) => setTimeout(r));
    }
  }
  // a scene's sub-frame as far as which pipelines it wants (drawSub's, without its data)
  planOf(scene) {
    const look = this.look;
    if (look === 'solid') scene = solidScene(scene);
    if (look === 'wire') scene = { ...scene, view: {} };
    const meshes = scene.nodes.filter((n) => n?.mesh && n.instances?.length), layers = scene.nodes.filter((n) => n && (n.tex || n.fx) && (n.opacity ?? 1) > 0.001);
    this.useSurfaces(meshes);
    const lights = look === 'solid' ? [] : lightsOf(scene, this.shadowsAll), { tracing, traced, giAsked, how } = this.tracingOf(scene, meshes, lights);
    const of = (glass) => meshes.map((n, i) => (!n.material.glass === !glass ? i : -1)).filter((i) => i >= 0);
    return { scene, meshes, solids: of(false), glass: of(true), layers, look, first: true, shadowed: traced && lights.some((L) => L.shadows),
      gi: tracing.gi ? how(giAsked, 'gi') : null, reflect: tracing.reflect > 0, keep: tracing.keep > 0 };
  }

  /** What a film's pass that picks (fn pick) has at frame point (x, y) in `scene`: { t, id }, or null (see passes/film.js). */
  pickPass(n, scene, x, y) { return this.exclusive(() => pickPass(this, n, scene, x, y)); }

  /**
   * The frame's passes on what its sub-frames added up (frame = { view, post, passes, t }: the view transform, bloom and
   * vignette, the film's frame passes), and the frame read back as RGBA bytes. partial: a frame shown while it is drawn,
   * what the sub-frames so far added up × `partial` (its sub-frames over those drawn: as if all were), the sub-frames to
   * come adding to what these did. (this.take: given the bytes as the GPU's buffer holds them instead, returning nothing:
   * a frame that goes straight on needs no copy of its own.)
   */
  finish(frame = {}, partial = 0, target = null) { return this.exclusive(() => this.endFrame(frame, partial, target)); }
  async endFrame(frame, partial, target) {
    const dev = this.dev, quick = this.look === 'solid' || this.look === 'wire';
    if (partial) this.scaleSums(partial);
    // (the view transform the frame's sub-frames were drawn for, where it is not given: the director's view's)
    const f = { view: quick ? {} : frame.view ?? this.sub?.scene.view ?? {}, post: quick ? {} : frame.post ?? {}, passes: quick ? [] : frame.passes ?? [], t: frame.t ?? 0 };
    const recording = performance.now();
    this.enc = dev.createCommandEncoder();
    for (const p of this.passes) if (p.stage === 'frame') { this.prof.at(p.name); await p.run(this, f); }
    // (target: what the frame is drawn onto, nothing read back: a canvas of the page's own, or the image of a ring the
    // editor's window shares, which it gives once one is free, acquire(w, h), and is told of once its copy is sent,
    // submitted(): the viewport's render process, runtime.js)
    if (target) {
      const into = target.acquire ? await target.acquire(this.pw, this.ph) : null;
      if (!into && (target.canvas.width !== this.pw || target.canvas.height !== this.ph)) { target.canvas.width = this.pw; target.canvas.height = this.ph; }
      this.enc.copyTextureToTexture({ texture: this.out }, { texture: into ?? target.getCurrentTexture() }, [this.pw, this.ph]);
    } else this.enc.copyTextureToBuffer({ texture: this.out }, { buffer: this.readBuf, bytesPerRow: this.readRow }, [this.pw, this.ph]);
    this.prof.resolve(this.enc);
    dev.queue.submit([this.enc.finish()]);
    target?.submitted?.();
    this.prof.add('GPU commands', recording);
    if (!partial) { const building = performance.now(); renewTree(this); this.prof.add('Scene data', building); }
    // how long the GPU spent on a sub-frame of this one, once it is done: the next frame draws its heavy passes in as many
    // bands as keep each under CHUNK_MS
    const F = !partial && this.frame;
    if (F) this.frame = null;
    const banded = () => { if (F) this.bands = Math.max(1, Math.min(16, Math.ceil((F.gpu || performance.now() - F.began) / F.subs / (2 * CHUNK_MS)))); };
    if (target) { dev.queue.onSubmittedWorkDone().then(banded); if (partial) this.scaleSums(0); return null; }
    const waiting = performance.now();
    await this.readBuf.mapAsync(GPUMapMode.READ);
    this.prof.add('GPU wait', waiting);
    banded();
    const rows = new Uint8Array(this.readBuf.getMappedRange());
    let px = null;
    if (this.readRow === this.pw * 4 && this.take) { const handing = performance.now(); this.take(rows); this.prof.add('Hand over', handing); }
    else px = unpadded(rows, this.readRow, this.pw, this.ph);
    this.readBuf.unmap();
    if (partial) this.scaleSums(0);
    return px;
  }
  /**
   * The frame last finished, as it is now (what a canvas it was drawn onto shows), read back: a promise of { px: RGBA bytes,
   * w, h }, or null while the one asked before is still on its way. Copied at once into a buffer of its own, so that
   * neither what is drawn meanwhile nor the frames that follow wait for it.
   */
  read() {
    if (this.reading) return null;
    const dev = this.dev, w = this.pw, h = this.ph, row = this.readRow;
    if (this.readBack?.size !== row * h) { this.readBack?.destroy(); this.readBack = dev.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'a frame read back' }); }
    const buf = this.readBack, enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.out }, { buffer: buf, bytesPerRow: row }, [w, h]);
    dev.queue.submit([enc.finish()]);
    return (this.reading = buf.mapAsync(GPUMapMode.READ)
      .then(() => { const px = unpadded(new Uint8Array(buf.getMappedRange()), row, w, h); buf.unmap(); return { px, w, h }; })
      .finally(() => { this.reading = null; }));
  }
  scalerDesc() {
    const mod = this.module(/* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0); }
@group(0) @binding(0) var light: texture_2d<f32>;
@group(0) @binding(1) var authored: texture_2d<f32>;
@group(0) @binding(2) var<uniform> k: vec4f;
struct Out { @location(0) light: vec4f, @location(1) authored: vec4f };
@fragment fn fs(@builtin(position) p: vec4f) -> Out { let q = vec2i(p.xy); return Out(textureLoad(light, q, 0) * k.x, textureLoad(authored, q, 0) * k.x); }`, 'a frame so far');
    return { layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } };
  }
  // what the sub-frames added up (the frame's light and the layers as authored over it) kept aside and given to the
  // frame's passes × k, which they may draw over; k 0: put back as they were kept
  scaleSums(k) {
    const dev = this.dev, U = GPUTextureUsage, size = [this.pw, this.ph], enc = dev.createCommandEncoder();
    if (this.sums?.w !== this.pw || this.sums?.h !== this.ph) {
      for (const t of this.sums?.tex ?? []) t.destroy();
      const tex = ['light', 'authored'].map((n) => dev.createTexture({ size, format: 'rgba16float', label: `${n} so far`, usage: U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST }));
      this.sums = { w: this.pw, h: this.ph, tex, k: dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) };
    }
    const [light, authored] = this.sums.tex;
    if (!k) {
      enc.copyTextureToTexture({ texture: light }, { texture: this.tex.light }, size);
      enc.copyTextureToTexture({ texture: authored }, { texture: this.tex.authored }, size);
      return dev.queue.submit([enc.finish()]);
    }
    this.scaler ??= dev.createRenderPipeline(this.scalerDesc());   // (asked for before the one made ready in the constructor is)
    dev.queue.writeBuffer(this.sums.k, 0, new Float32Array([k, 0, 0, 0]));
    enc.copyTextureToTexture({ texture: this.tex.light }, { texture: light }, size);
    enc.copyTextureToTexture({ texture: this.tex.authored }, { texture: authored }, size);
    const bg = dev.createBindGroup({ layout: this.scaler.getBindGroupLayout(0), entries: [{ binding: 0, resource: light.createView() }, { binding: 1, resource: authored.createView() }, { binding: 2, resource: { buffer: this.sums.k } }] });
    const p = enc.beginRenderPass({ label: 'a frame so far', colorAttachments: [this.clear('light'), this.clear('authored')] });
    p.setPipeline(this.scaler); p.setBindGroup(0, bg); p.draw(3); p.end();
    dev.queue.submit([enc.finish()]);
  }
}

// a frame's rows as the GPU's buffer holds them (each padded to `stride` bytes), as RGBA rows of its own
function unpadded(rows, stride, w, h) {
  const row = w * 4;
  if (stride === row) return rows.slice(0, row * h);
  const px = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) px.set(rows.subarray(y * stride, y * stride + row), y * row);
  return px;
}
const unit = (v) => { const k = Math.hypot(...v) || 1; return v.map((x) => x / k); };
// the Solid look: every mesh in its own colour, matte and opaque, under a plain studio; no glass, glow or mirror; layers
// as authored
function solidScene(s) {
  return { ...s, environment: STUDIO, view: {}, reflections: false, gi: false, nodes: s.nodes.filter((n) => n && !n.light).map((n) => (n.mesh ? { ...n, material: matte(n.material), surface: null } : n.lit ? { ...n, lit: false } : n)) };
}

export { axes };
