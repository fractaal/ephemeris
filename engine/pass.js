// Passes: a film's own full-screen shaders, run on the picture as it is drawn. Ephemeris assumes WebGPU and nothing
// else about how a film looks: what the renderer ships (meshes, their materials, traced light) is one way to draw, and
// a pass is how a film draws its own way — fog and light in it, a grade, grain, a print's halation, a whole scene
// raymarched. Made with F.pass(code, { stage, params, label }) and placed among a scene's nodes with .at(), as a mesh or
// a light is, so the editor finds it and shows its params as lanes:
//
//   const PRINT = F.pass(`
//   fn draw(px: vec2f, uv: vec2f) -> vec4f {
//     let c = input(px).rgb;
//     let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
//     return vec4f(vec3f(l) * p.tint + (filmGrain(px) - 0.5) * p.grain, 1.0);
//   }`, { stage: 'display', label: 'print', params: { grain: 0.08, tint: '#fff6e6' } });
//   nodes.push(PRINT.at({ grain: motion(0.08).to(12, 0.1, 0.14) }));   // a param as a motion: lanes in the editor
//
// Its stage says where it runs (passes of a stage run in scene order, each on what the one before it made):
//   scene     each sub-frame, on what is opaque (light, linear), with where each pixel's surface is: fog, light in it,
//             a raymarched world (which may draw surfaces the rest of the frame meets: drawSurface, below)
//   light     (the default) once a frame, on the frame's light (what the sub-frames added up, before the view
//             transform): halation, glows, a grade in light
//   display   once a frame, on the frame as seen (after the view transform, the layers as authored over it): grain, a
//             print's look, a grade on the picture
//
// The code defines fn draw(px: vec2f, uv: vec2f) -> vec4f: px the pixel's centre in frame px (0–W, 0–H, y down: the
// film's frame, 1920 × 1080 unless its timeline's size says), uv the same 0–1; it returns the pixel's new colour (rgb;
// alpha is ignored). It sees the scene as the renderer's own shaders do (engine/render/shaders.js: cam, world, the lights,
// the environment, the scene's tables) and what engine/render/passes/film.js gives it:
//   p.<name>                  its params (numbers as f32; [a, b], [a, b, c], [a, b, c, d] as vec2f…vec4f; a CSS colour
//                             as a vec3f in linear light), set per node by .at({ … }); a number given as a motion animates.
//                             Declared as { value, min, max, step }, a param's range is the editor's slider
//   film.t, film.frame,       the moment (the sub-frame's, in the scene stage), the frame's index, the film's fps, a
//   film.fps, film.seed       seed that differs per sub-frame
//   film.size, film.texel     the size of what it draws (px: the frame's, or its target's), the texels a px it is drawn at
//   input(px), inputAt(uv, lod), inputSmooth(uv, lod)   the picture so far, exact, and blurred by level
//   surface(px), surfaceNormal(px)   scene stage: where the opaque surface there is (w 1 where there is one), its normal
//   viewRay(px)               the camera's ray through the pixel (o, d), with this sub-frame's offset and lens
//   material(base, rough, metal), litMaterial(X, N, V, m), litMaterialReflecting, shownAsMeshes, seenThrough   a
//                             surface of its own lit as meshes are, by the same code: the environment, the lights (their
//                             shadows traced through the scene where they ask), and, with fn sceneDistance, its own
//                             shadows and occlusion (softShadow, occlusion)
//   environment(R, spread), irradiance(N), lightCount(), world.lights[i], lightHere(i, X), reflection(…)   the scene's
//   data[i] (vec4f)           .at(params, { data }): any numbers the film computes, 4 a slot
//   hash3(v), noise3(v), filmGrain(px), lin(c), srgb(c), luma(c), PI, TAU
// World units are px, as everywhere in the world: y down, z toward the viewer.
//
// A scene-stage pass may also draw surfaces of its own (a raymarched world, an SDF face) that the rest of the frame
// meets: instead of fn draw it defines fn drawSurface(px: vec2f, uv: vec2f) -> Surface, returning
// Surface(colour, world point with w 1 where it drew a surface (0: none here, only the colour changes), normal). Its
// surfaces are depth tested against what is opaque already (a mesh nearer than them hides them) and then are what is
// opaque there: layers and glass go in front of or behind them by depth, and a later pass's surface() sees them.
//
// What a person clicks on in what a pass draws: a pass that draws things defines fn pick(px: vec2f) -> vec2f, returning
// how far along the camera's ray (viewRay) the thing there is (px; below 0: nothing of this pass's there) and an id of
// the film's choosing. The editor runs it for the one pixel clicked and takes the nearest of it and the rest of the
// scene; with `pick` (the JS option, id → the label of a placed thing, a light say) a click selects that thing,
// otherwise the pass itself, with its params. A world drawn in one pass so picks the lights it draws.
//
// Pictures of its own: F.texture(url or { width, height, data, format }) is an image beside the page (loaded before
// ready(), with its mip levels) or the film's own numbers; F.target({ scale or size, format }) is a picture a pass draws
// into instead of the frame (target: TARGET; then px and film.size are the target's, uv the same as the frame's) and a
// later pass reads (textures: { name: TARGET }): a glow made at half size and blurred at a quarter, a mask, a buffer.
// once: true draws a pass on a frame's first sub-frame only, and gives what it drew to the frame's other sub-frames: for
// a costly world that does its own antialiasing (no motion blur on what it draws, and 1× the cost, not 8×).
//
// Nothing here is the way to draw: the built-in looks (elements/looks/) are passes written this way, to use as they
// are, change, or replace.
import { placed, rgb } from './mesh.js';
import { settle, motionsUsed, STACKS, isMotion } from './motion.js';

const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED = new Set(['p', 'film', 'cam', 'world', 'scn', 'insts', 'geo', 'sp', 'obj', 'data', 'src', 'smp', 'smpWrap', 'posT', 'nrmT', 'depthT', 'FRAME', 'PX']);
const TURN = ['rx', 'ry', 'rz', 's'];   // (a placed pass's own: where it is turned and how large, besides x, y, z)
const kindOf = (v, k, label) => {
  if (typeof v === 'number') return 'f32';
  if (typeof v === 'string' && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) return 'vec3f';
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number')) return `vec${v.length}f`;
  throw new Error(`pass "${label}": param "${k}" must be a number, [2–4 numbers] or a CSS colour (it is ${JSON.stringify(v)})`);
};
const SIZE = { f32: [4, 4], vec2f: [8, 8], vec3f: [16, 12], vec4f: [16, 16] };   // align, size (WGSL's uniform rules)
// a param declared with its range, { value, min, max, step }
const ranged = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && 'value' in v;
const PART = ['x', 'y', 'z', 'w'];
/**
 * Defaults with the film's own values over them, keeping each default's range ({ value, min, max, step }) where the
 * film gives a plain value: for a look's factory (elements/looks/), so its sliders stay.
 */
export function withDefaults(defaults, given = {}) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(given)) out[k] = ranged(out[k]) && !ranged(v) ? { ...out[k], value: v } : v;
  return out;
}
/** The params the editor shows as numbers (lanes): each number, and each part of a vector as name.x, name.y… */
export const editable = (params) => Object.entries(params ?? {}).flatMap(([k, v]) => (typeof v === 'number' ? [k] : Array.isArray(v) ? v.map((_, i) => `${k}.${PART[i]}`) : []));
/** A param's value by the editor's name for it (a vector's part: name.x). */
export function paramValue(params, k) {
  const [base, part] = k.split('.'), v = params?.[base];
  if (part == null) return v;
  return Array.isArray(v) ? v[PART.indexOf(part)] : undefined;
}
/** The params with one set by the editor's name for it (a vector's part: a copy of the vector, that part changed). */
export function withParam(params, k, value) {
  const [base, part] = k.split('.');
  if (!(base in params)) return params;
  if (part == null) return { ...params, [base]: value };
  const v = [...params[base]]; v[PART.indexOf(part)] = value;
  return { ...params, [base]: v };
}

/**
 * A shader's params as declared ({ name: value } or { name: { value, min, max, step } }): each one's value (defaults),
 * the ranges given with some (the editor's sliders), and where each sits in its uniform (layout). A pass's and a
 * surface's (engine/surface.js).
 */
export function paramsOf(params, label) {
  const ranges = {};
  const defaults = Object.fromEntries(Object.entries(params).map(([k, v]) => {
    if (!ranged(v)) return [k, v];
    ranges[k] = { min: v.min, max: v.max, step: v.step };
    return [k, v.value];
  }));
  return { defaults, ranges, layout: layoutOf(defaults, label) };
}
/** Where each param sits in the params uniform (WGSL's layout), and the struct the shader sees. */
function layoutOf(params, label) {
  const fields = [];
  let off = 0;
  for (const [k, v] of Object.entries(params)) {
    if (!NAME.test(k) || RESERVED.has(k)) throw new Error(`pass "${label}": "${k}" cannot name a param`);
    const type = kindOf(v, k, label), [align, size] = SIZE[type];
    off = Math.ceil(off / align) * align;
    fields.push({ k, type, off: off / 4, n: size / 4 });
    off += size;
  }
  const bytes = Math.max(16, Math.ceil(off / 16) * 16);
  const struct = `struct Params { ${fields.length ? fields.map((f) => `${f.k}: ${f.type},`).join(' ') : '_none: f32,'} };`;
  return { fields, bytes, struct };
}

/**
 * A picture a film's passes read (F.texture): an image (a URL, beside the film's page: loaded before ready(), with its
 * mip levels; colour: false for one that holds numbers, not colours) or the film's own numbers ({ width, height, data,
 * format: 'rgba8unorm' or 'rgba32float' }, rgba a texel; rgba32float is read with textureLoad, not sampled). Wrapped
 * (repeat) or clamped as the sampler that reads it says: smpWrap or smp.
 */
export class Texture {
  constructor(source, { label = 'texture', colour = true } = {}) {
    const url = typeof source === 'string';
    if (!url && !(source?.width > 0 && source?.height > 0 && source?.data)) throw new Error(`texture "${label}": a URL, or { width, height, data, format }`);
    this.label = label; this.url = url ? source : null; this.colour = colour;
    this.width = url ? 0 : source.width; this.height = url ? 0 : source.height;
    this.format = url ? (colour ? 'rgba8unorm-srgb' : 'rgba8unorm') : source.format ?? (source.data instanceof Float32Array ? 'rgba32float' : 'rgba8unorm');
    if (!['rgba8unorm', 'rgba8unorm-srgb', 'rgba32float'].includes(this.format)) throw new Error(`texture "${label}": format rgba8unorm or rgba32float`);
    this.data = url ? null : source.data;
    this.image = null;   // (an image, once loaded: see load())
  }
  /** Loads an image texture (a URL relative to `base`, the page). */
  async load(base) {
    if (!this.url) return;
    const r = await fetch(new URL(this.url, base));
    if (!r.ok) throw new Error(`texture "${this.label}": ${this.url} (${r.status})`);
    this.image = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none' });
    this.width = this.image.width; this.height = this.image.height;
  }
}
/**
 * A picture a film's passes draw (a pass's `target`) and others read (`textures`): its size the frame's × scale, or
 * size: [w, h] px; format rgba16float (light) or rgba8unorm. It holds what was drawn into it last: within a sub-frame
 * for scene-stage passes, a frame for light- and display-stage ones (never from one frame to the next: every frame is a function
 * of its moment).
 */
export class Target {
  constructor({ label = 'target', scale = 1, size = null, format = 'rgba16float' } = {}) {
    if (!['rgba16float', 'rgba8unorm'].includes(format)) throw new Error(`target "${label}": format rgba16float or rgba8unorm`);
    this.label = label; this.scale = scale; this.size = size; this.format = format;
  }
}

export class Pass {
  constructor(code, { stage = 'light', params = {}, label = 'pass', bounds = null, pick = null, textures = {}, target = null, once = false } = {}) {
    if (!['scene', 'light', 'display'].includes(stage)) throw new Error(`pass "${label}": stage is 'scene', 'light' (once a frame, on its light, before the view transform) or 'display' (on the frame as seen), not ${JSON.stringify(stage)}`);
    if (!/fn\s+(draw|drawSurface)\s*\(/.test(code)) throw new Error(`pass "${label}": its code defines fn draw(px: vec2f, uv: vec2f) -> vec4f (or, scene stage, fn drawSurface(…) -> Surface)`);
    this.code = code;
    this.stage = stage;
    this.surfaces = /fn\s+drawSurface\s*\(/.test(code);
    if (this.surfaces && stage !== 'scene') throw new Error(`pass "${label}": only a scene-stage pass draws surfaces (drawSurface)`);
    this.label = label;
    // what a click on it selects (see above): whether its code says what is where, and its ids' things, by label
    this.picks = /fn\s+pick\s*\(/.test(code);
    this.pickTo = pick;
    // a placed pass: a thing in the world (an SDF object), its own space within these half extents (px), so the editor
    // picks it, outlines it and moves it as it does a mesh
    this.bounds = bounds == null ? null : typeof bounds === 'number' ? [bounds, bounds, bounds] : bounds;
    if (this.bounds && stage !== 'scene') throw new Error(`pass "${label}": a placed pass (bounds) draws in the world: stage 'scene'`);
    for (const k of this.bounds ? ['x', 'y', 'z', ...TURN] : []) if (k in params) throw new Error(`pass "${label}": "${k}" is where a placed pass is: name its param otherwise`);
    Object.assign(this, paramsOf(params, label));   // (defaults, ranges, layout)
    // the pictures it reads, by the names its code reads them by; where it draws (a target of its own, not the frame);
    // whether it draws once a frame (on its first sub-frame, what it drew then given to the rest)
    for (const [k, t] of Object.entries(textures)) {
      if (!NAME.test(k) || RESERVED.has(k) || k in this.defaults) throw new Error(`pass "${label}": "${k}" cannot name a texture`);
      if (!(t instanceof Texture) && !(t instanceof Target)) throw new Error(`pass "${label}": texture "${k}" is one F.texture() or F.target() made`);
    }
    if (target && !(target instanceof Target)) throw new Error(`pass "${label}": its target is one F.target() made`);
    if (target && this.surfaces) throw new Error(`pass "${label}": a pass that draws surfaces draws into the frame, not a target`);
    if (target && Object.values(textures).includes(target)) throw new Error(`pass "${label}": it cannot read the target it draws into`);
    if (once && this.surfaces) throw new Error(`pass "${label}": once is for a pass that draws colour (draw), not surfaces`);
    this.textures = textures; this.target = target; this.once = !!once;
  }
  /**
   * A scene node: this pass with its params for this moment (any of them a motion), and data: numbers for data[].
   * .at({ …params }, { data }); a placed pass (bounds) .at(x, y, z, { rx, ry, rz, s, …params }, { data }), as a mesh.
   */
  at(...a) {
    let [x, y, z, o, extra] = typeof a[0] === 'number' || isMotion(a[0]) ? [a[0], a[1] ?? 0, a[2] ?? 0, a[3] ?? {}, a[4] ?? {}] : [0, 0, 0, a[0] ?? {}, a[1] ?? {}];
    // (a value given as a motion is its value now, and the node remembers it: the editor shows its lanes)
    const from = motionsUsed() ? {} : null;
    if (from) { ({ x, y, z } = settle({ x, y, z }, from)); o = settle(o, from); }
    const where = {}, params = { ...o };
    if (this.bounds) for (const k of TURN) if (k in params) { where[k] = params[k]; delete params[k]; }
    for (const k of Object.keys(params)) if (!(k in this.defaults)) throw new Error(`pass "${this.label}": no param "${k}" (its params: ${Object.keys(this.defaults).join(', ') || 'none'})`);
    const n = { pass: this, of: this, params: { ...this.defaults, ...params }, data: extra.data ?? null, label: this.label, ...(this.bounds && { x, y, z, ...where }), ...placed(this) };
    if (from && Object.keys(from).length) n[STACKS] = from;
    return n;
  }
}

/** A pass node's (or a surface's) params as its uniform holds them. */
export function paramData(P, params) {
  const d = new Float32Array(P.layout.bytes / 4);
  for (const f of P.layout.fields) {
    const v = params[f.k];
    if (typeof v === 'number') d[f.off] = v;
    else if (typeof v === 'string') d.set(rgb(v), f.off);
    else if (Array.isArray(v)) d.set(v.slice(0, f.n), f.off);
  }
  return d;
}
