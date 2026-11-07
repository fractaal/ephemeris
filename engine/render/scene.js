// A sub-frame's scene as the shaders read it (shaders.js): the camera, the world (the environment, its light as
// spherical harmonics, the lights, where the tables are, what is traced), and the scene's tables — every mesh node's
// material and shape, every layer in the world as a plane, every copy and layer in a hierarchy that rays walk.
import { rowsInto } from '../between.js';
import { basis } from '../camera.js';
import { rgb, instanceData, INSTANCE_FLOATS } from '../mesh.js';
import { lightWay } from '../light.js';
import { MAX_LIGHTS, MAX_GLOWS, WORLD_FLOATS, TRANSFORMS } from './shaders.js';
import { MATERIAL_VEC4S, packMaterial } from './materials.js';
import { hierarchy, refit, surface } from './geometry.js';
import { SHEEN_LUT } from './sheen.js';
import { GGX_LUT } from './ggx.js';
import { STRIDE } from './surfaces.js';
import { paramData, Texture } from '../pass.js';

// the light falling on things unless a scene says (an overcast studio)
export const ENVIRONMENT = { zenith: '#d7dce4', horizon: '#9a9ca2', nadir: '#45464b', intensity: 1 };

/** A plane's half axes in the world (a layer's), from its size and turn (X, then Y, then Z, about its centre). */
export function axes(n) {
  const r = (d) => ((d ?? 0) * Math.PI) / 180;
  const R = (v) => {
    let [x, y, z] = v; let c, s;
    c = Math.cos(r(n.rx)); s = Math.sin(r(n.rx)); [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(r(n.ry)); s = Math.sin(r(n.ry)); [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(r(n.rz)); s = Math.sin(r(n.rz)); [x, y] = [x * c - y * s, x * s + y * c];
    return [x, y, z];
  };
  return [R([n.w / 2, 0, 0]), R([0, n.h / 2, 0])];
}

/** The camera for this sub-frame (jitter: its offset in drawn px; lens: its point on the lens; phase, weight): { B (its basis),
 *  eye (where it is, on the lens), j (its offset, frame px), data (the camera uniform) }. */
export function cameraData(R, camera, jitter, lens, phase, weight, seed) {
  const B = basis(camera), dof = camera.dof;
  let eye = B.eye, j = [jitter[0] / R.rs, jitter[1] / R.rs];   // (a pixel of the frame as drawn, in frame px)
  // depth of field: the eye moves across the lens, and the plane in focus is held still on the frame
  if (dof?.aperture) {
    const f = dof.focus ?? B.dist, focus = Array.isArray(f) ? -[0, 1, 2].reduce((a, k) => a + (f[k] - B.eye[k]) * B.back[k], 0) : f;
    const lx = lens[0] * dof.aperture, ly = lens[1] * dof.aperture;
    eye = B.eye.map((e, k) => e + B.right[k] * lx + B.down[k] * ly);
    j = [j[0] + (lx * B.focal) / focus, j[1] + (ly * B.focal) / focus];
  }
  return { B, eye, j, data: new Float32Array([...eye, B.focal, ...B.right, phase, ...B.down, weight, ...B.back, seed, ...j, R.fw / 2, R.fh / 2, R.pw, R.ph, R.rs, 0]) };
}

// the environment's light falling on a surface facing each way, divided by π (what a white matte surface shows), as L2
// spherical harmonics: the environment projected on them (by numbers, over the sphere) and convolved with the cosine
// lobe (Ramamoorthi and Hanrahan 2001: π, 2π/3, π/4 by band). Each direction's light is its own mix of the three colours,
// whatever they are, so what each colour gives is found once and they are added up as a scene's say.
const SKY_SH = (() => {
  const Y = ([x, y, z]) => [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
  const A = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];   // (each band's π, 2π/3, π/4, over π)
  const K = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
  const sh = { zenith: new Float64Array(9), horizon: new Float64Array(9), nadir: new Float64Array(9) }, nt = 48, np = 96;
  for (let i = 0; i < nt; i++) for (let j = 0; j < np; j++) {
    const th = ((i + 0.5) / nt) * Math.PI, ph = ((j + 0.5) / np) * 2 * Math.PI, dw = Math.sin(th) * (Math.PI / nt) * ((2 * Math.PI) / np);
    const d = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)], e = -d[1], y = Y(d);
    const up = Math.pow(Math.min(Math.max(e, 0), 1), 0.6), dn = Math.pow(Math.min(Math.max(-e, 0), 1), 0.6), far = e > 0 ? up : dn;
    for (let k = 0; k < 9; k++) { const w = y[k] * dw * A[k] * K[k]; sh.horizon[k] += (1 - far) * w; if (e > 0) sh.zenith[k] += far * w; else sh.nadir[k] += far * w; }
  }
  return sh;
})();
// env's harmonics, 4 floats each (3 and one unused), into out at `at`
function shInto(env, out, at) {
  for (let k = 0; k < 9; k++) for (let q = 0; q < 3; q++) out[at + k * 4 + q] = env.intensity * (env.zenith[q] * SKY_SH.zenith[k] + env.horizon[q] * SKY_SH.horizon[k] + env.nadir[q] * SKY_SH.nadir[k]);
}

/** The scene's lights as the shaders read them: its light nodes (F.light), up to MAX_LIGHTS. all: the timeline's shadows for every light (true, false; null: as each says). */
function lightsOf(scene, all) {
  const out = [];
  for (const n of scene.nodes) {
    if (!n?.light) continue;
    if (out.length === MAX_LIGHTS) { console.warn(`[render] a scene has more than ${MAX_LIGHTS} lights; it is lit by its first ${MAX_LIGHTS}`); break; }
    const at = [n.x ?? 0, n.y ?? 0, n.z ?? 0], unit = (v) => { const k = Math.hypot(...v) || 1; return v.map((x) => x / k); };
    const dir = unit(lightWay(n, at));
    out.push({ ...n, at, dir, shadows: all ?? n.shadows === true });
  }
  return out;
}

/** A scene's view transform as the shaders name it (TRANSFORMS's index): agx unless it says. */
export function viewIndex(view) {
  const t = TRANSFORMS.indexOf(view?.transform ?? 'agx');
  if (t < 0) throw new Error(`a scene's view transform is ${TRANSFORMS.map((x) => `'${x}'`).join(', ')} (not ${JSON.stringify(view.transform)})`);
  return t;
}
// a colour as picked: CSS hex, or sRGB [r, g, b] 0–1
const srgbOf = (c) => (Array.isArray(c) ? c : (c.replace('#', '').length === 3 ? [...c.replace('#', '')].map((x) => x + x) : c.replace('#', '').match(/../g).slice(0, 3)).map((x) => parseInt(x, 16) / 255));
const LIGHT_FLOOR = 0.002;   // (the light, linear, below which one no longer reaches: see reach)
/** The world uniform: environment, lights, tables, tracing. */
export function worldData(scene, lights, tables, tracing) {
  const d = new Float32Array(WORLD_FLOATS), di = new Int32Array(d.buffer);
  const e = { ...ENVIRONMENT, ...scene.environment };
  const env = { zenith: rgb(e.zenith), horizon: rgb(e.horizon), nadir: rgb(e.nadir), intensity: e.intensity };
  // (the backdrop: a colour, or { color, glows: [{ x, y, r, color }] }: soft glows on it, frame px; as seen: sRGB)
  const bd = typeof e.backdrop === 'object' && !Array.isArray(e.backdrop) ? e.backdrop : { color: e.backdrop }, glows = (bd.glows ?? []).slice(0, MAX_GLOWS);
  d.set([...env.zenith, env.intensity, ...env.horizon, lights.length, ...env.nadir, glows.length]);
  if (bd.color) d.set([...srgbOf(bd.color), 1], 12);
  d.set([scene.view?.exposure ?? 1, viewIndex(scene.view), 0, 0], 16);
  glows.forEach((g, i) => d.set([g.x ?? 0, g.y ?? 0, g.r ?? 600, 0, ...srgbOf(g.color ?? '#ffffff'), 0], 20 + i * 8));
  shInto(env, d, 68);
  di.set([tables.tlas, tables.items, tables.materials, tables.shapes, tables.layers, tables.emitters, tables.emitterCount, tables.traced], 104);
  d.set([tracing.shadowRays, tracing.keep, tracing.reuse, tracing.reflect, tracing.gi, tracing.ao, 0, 0], 112);
  lights.forEach((L, i) => {
    const o = 120 + i * 16, c = rgb(L.color ?? '#ffffff').map((v) => v * (L.intensity ?? 1)), kind = { point: 0, spot: 1, sun: 2 }[L.light] ?? 0;
    const half = (((L.angle ?? (kind === 2 ? 1 : 40)) / 2) * Math.PI) / 180, soft = Math.min(1, Math.max(0, L.soft ?? 0.25));
    // its reach: where it is asked to end (range, px), or where its light has fallen to too little to see with the
    // others' (each of n ends below 1/n of the floor, so what they leave out at any point adds up to no more than it)
    const reach = L.range ?? 1000 * Math.sqrt((Math.max(...c, 0) * lights.length) / LIGHT_FLOOR);
    d.set([...L.at, Math.max(0, L.radius ?? 20), ...c, kind, ...L.dir, Math.cos(half), Math.cos(half * (1 - soft)), L.shadows ? 1 : 0, reach * reach, kind === 2 ? half : 0], o);
  });
  return d;
}

/**
 * The scene's tables (scn): every copy of every mesh node and every layer in the world, in a hierarchy over their boxes
 * (kept while nothing in it has moved: most sub-frames of most frames), each entry a copy (its instance, its node) or a
 * layer (-1 - its index); each node's material (MATERIAL_VEC4S) and shape (solid, its triangles' root, indices and
 * vertices in the geometry; a solid's half extents and edge radius); each layer's plane (centre, opacity; half axes, its
 * picture's handle; half axes, how bright its light; lit); with GI, its emitters (emitters: emittersData's, 2 vec4s
 * each). First of all, at 0, the sheen's table (sheen.js), which every surface with sheen reads, and GGX's (ggx.js), which every surface reads. boxes: the copies'
 * (copyBoxes, shutterBoxes). trace: whether anything is traced (else only the tables shading reads). Returns where each table starts, the tables, and the first of their numbers that may have changed since they were last made.
 */
export function tablesData(R, meshes, layers, inst, boxes, trace, emitters = null) {
  const n = trace ? boxes.n + layers.length : 0, T = R.tlas;
  // (the boxes the hierarchy was last made for, nothing else in it: it stands, as for a frame's sub-frames between its moments)
  const stands = T?.boxes === boxes && T.n === n && !layers.length;
  const lo = stands ? null : new Float64Array(n * 3), hi = stands ? null : new Float64Array(n * 3), c = stands ? null : new Float64Array(n * 3), items = stands ? null : new Float32Array(n * 4);
  const mats = new Float32Array(meshes.length * MATERIAL_VEC4S * 4), shapes = new Float32Array(meshes.length * 8), lay = new Float32Array(layers.length * 16);
  if (trace && !stands) { lo.set(boxes.lo); hi.set(boxes.hi); c.set(boxes.c); }
  let e = 0;
  meshes.forEach((m, i) => {
    const mat = m.material, solid = m.mesh.solid, g = R.geometry.of(m.mesh.geo);
    const baseTex = m.mesh.texture ? R.textures.handle(m.mesh.texture) : -1, normalTex = m.mesh.normalMap && !mat.glass ? R.textures.handle(m.mesh.normalMap, { numbers: true }) : -1;
    packMaterial(mat, { baseTex, normalTex, surface: m.spId ?? 0, bounces: R.rendering.glass?.bounces }, mats, i * MATERIAL_VEC4S * 4);
    shapes.set([solid ? 1 : 0, g.nodes, g.tris, g.verts, ...(solid?.half ?? [0, 0, 0]), solid?.r ?? 0], i * 8);
    if (!trace || stands) return;
    for (let k = 0; k < m.instances.length; k++, e++) { items[e * 4] = m.first + k; items[e * 4 + 1] = i; }
  });
  layers.forEach((l, li) => {
    const [U, V] = axes(l), C = [l.x, l.y, l.z ?? 0];
    lay.set([...C, l.opacity ?? 1, ...U, R.textures.handle(l.tex, { layer: true }), ...V, (l.bright ?? 1) ** 2.2, l.lit ? 1 : 0, 0, 0, 0], li * 16);
    if (!trace) return;
    for (let a = 0; a < 3; a++) { const ea = Math.abs(U[a]) + Math.abs(V[a]) + 0.5; c[e * 3 + a] = C[a]; lo[e * 3 + a] = C[a] - ea; hi[e * 3 + a] = C[a] + ea; }
    items[e * 4] = -1 - li;
    e++;
  });
  // the hierarchy rays walk: its boxes refit where they have moved (as good as a new one for things that move as little as
  // they do in one exposure or from one frame to the next, and far cheaper), and built again only where the list of things
  // changes or they have moved so far that its boxes have grown by half (a cut, a jump along the timeline). The build a
  // film where everything sways needs each frame comes after the frame's last sub-frame (renewTree)
  if (!stands) {
    const same = (x, y) => { if (x.length !== y.length) return false; for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false; return true; };
    if (!T || !same(T.items, items)) R.tlas = treeOver(lo, hi, c, items, n);
    else if (!same(T.lo, lo) || !same(T.hi, hi)) {
      refit(T.tree, T.order, lo, hi); T.lo = lo; T.hi = hi; T.c = c; T.moved = true; T.data = null;
      if (surface(T.tree) > T.area * TREE_GREW) R.tlas = treeOver(lo, hi, c, items, n);
    }
    R.tlas.boxes = boxes; R.tlas.n = n;
  }
  const H = R.tlas, { tree, order } = H;
  const t = { tlas: (SHEEN_LUT.length + GGX_LUT.length) / 4, traced: n > 0 ? 1 : 0, emitters: 0, emitterCount: emitters ? emitters.length / 8 : 0 };
  t.items = t.tlas + tree.length / 4; t.materials = t.items + order.length; t.shapes = t.materials + meshes.length * MATERIAL_VEC4S;
  t.layers = t.shapes + meshes.length * 2; t.emitters = t.layers + layers.length * 4;
  const size = Math.max(4, t.emitters * 4 + t.emitterCount * 8);
  // (the tables up to the materials change with the hierarchy alone: written, and sent, only then. from: the first number that may have changed)
  let from = t.materials * 4;
  if (H.data?.length !== size) {
    const data = (H.data = new Float32Array(size)), it = H.items;
    data.set(SHEEN_LUT, 0); data.set(GGX_LUT, SHEEN_LUT.length); data.set(tree, t.tlas * 4);
    for (let i = 0, d = t.items * 4; i < order.length; i++, d += 4) { const q = order[i] * 4; data[d] = it[q]; data[d + 1] = it[q + 1]; }
    from = 0;
  }
  const data = H.data;
  data.set(mats, t.materials * 4); data.set(shapes, t.shapes * 4); data.set(lay, t.layers * 4);
  if (emitters) data.set(emitters, t.emitters * 4);
  return { tables: t, data, from };
}

const TREE_GREW = 1.5;
const treeOver = (lo, hi, c, items, n) => { const h = hierarchy(lo, hi, c, n); return { lo, hi, c, items, moved: false, area: surface(h.tree), ...h }; };
/**
 * The hierarchy built anew where its boxes have moved since it last was, for the next frame's sub-frames to refit: called
 * with a frame's work all sent, which the GPU goes on drawing while this runs, so that neither waits for the other. (The
 * GPU takes the same time over a tree one frame old: within 1% over spring-brutalist's facade and pool at 4 to 64
 * sub-frames, and over 8,000 things moving 100 px a frame. A much older one costs it more: the pool's rose 3 to 9% from
 * 48 frames on, while the boxes' areas hardly grew.)
 */
export function renewTree(R) {
  const T = R.tlas;
  if (T?.moved) R.tlas = treeOver(T.lo, T.hi, T.c, T.items, T.items.length / 4);
}

/**
 * Each copy's box in the world, in the instance buffer's order: its shape's box (a solid's, centred) through its model
 * columns. { lo, hi, c: low corners, high corners, centres (xyz each, flat), n }. What rays' hierarchy is built over
 * (tablesData) and what the camera's passes are culled by (passes/cull.js).
 */
export function copyBoxes(meshes, inst) {
  const n = meshes.reduce((a, m) => a + m.instances.length, 0);
  const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3), c = new Float64Array(n * 3);
  for (const m of meshes) {
    const solid = m.mesh.solid, [blo, bhi] = m.mesh.bounds, mid = solid ? [0, 0, 0] : [0, 1, 2].map((a) => (blo[a] + bhi[a]) / 2);
    const half = solid?.half ?? [0, 1, 2].map((a) => (bhi[a] - blo[a]) / 2);
    for (let k = 0; k < m.instances.length; k++) {
      const e = m.first + k, o = e * INSTANCE_FLOATS;
      for (let a = 0; a < 3; a++) {
        const M0 = inst[o + a], M1 = inst[o + 4 + a], M2 = inst[o + 8 + a];
        const ca = inst[o + a * 4 + 3] + M0 * mid[0] + M1 * mid[1] + M2 * mid[2];
        const ea = Math.abs(M0) * half[0] + Math.abs(M1) * half[1] + Math.abs(M2) * half[2];
        c[e * 3 + a] = ca; lo[e * 3 + a] = ca - ea; hi[e * 3 + a] = ca + ea;
      }
    }
  }
  return { lo, hi, c, n };
}

/**
 * The copies' boxes for a frame's sub-frames between its moments (scene.moments: between.js): each one's box at the three
 * taken together, which holds it wherever it is between them (a blend of its columns makes a box no larger than the blend
 * of its boxes), found once for them all. A hierarchy over them holds for the whole shutter, as a renderer's motion blur
 * has it (Cycles' over its motion steps): none of the sub-frames has to refit it, or send it.
 */
export function shutterBoxes(moments, meshes) {
  if (moments.boxes) return moments.boxes;
  const n = meshes.reduce((a, m) => a + m.instances.length, 0), inst = new Float32Array(n * INSTANCE_FLOATS);
  const at = ['A', 'M', 'B'].map((k) => { for (const m of meshes) inst.set(m.rows.all[k], m.first * INSTANCE_FLOATS); return copyBoxes(meshes, inst); });
  const { lo, hi, c } = at[0];
  for (const b of at.slice(1)) for (let i = 0; i < n * 3; i++) { if (b.lo[i] < lo[i]) lo[i] = b.lo[i]; if (b.hi[i] > hi[i]) hi[i] = b.hi[i]; }
  for (let i = 0; i < n * 3; i++) c[i] = (lo[i] + hi[i]) / 2;
  return (moments.boxes = { lo, hi, c, n });
}

/** Every mesh node's copies, in one instance buffer (each node's first copy: n.first). */
export function instancesData(meshes) {
  const inst = new Float32Array(Math.max(1, meshes.reduce((a, n) => a + n.instances.length, 0)) * INSTANCE_FLOATS);
  let at = 0;
  for (const n of meshes) {
    n.first = at;
    if (n.rows) rowsInto(n.rows, inst, at * INSTANCE_FLOATS); else instanceData(n.instances, inst, at * INSTANCE_FLOATS);
    at += n.instances.length;
  }
  return inst;
}

/**
 * The film's surfaces' params (sp: the film's moment first, then a mesh's at 1 + its index × STRIDE vec4s); a picture
 * among them as its handle in the texture store.
 */
export function surfacesData(R, meshes, t) {
  const d = new Float32Array((1 + meshes.length * STRIDE) * 4);
  d[0] = t;
  meshes.forEach((n, i) => {
    if (!n.surface) return;
    const params = Object.fromEntries(Object.entries(n.surface.params).map(([k, v]) => [k, v instanceof Texture ? R.textures.handle(v.image, { numbers: !v.colour }) : v]));
    d.set(paramData(n.surface.of, params), (1 + i * STRIDE) * 4);
  });
  return d;
}

export { lightsOf };
