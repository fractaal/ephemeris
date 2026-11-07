// Meshes: 3D geometry in the same world as the layers (px; x right, y down, z toward the viewer), lit, shadowed and
// depth-tested by the compositor. A film makes them with F.mesh(geometry) or F.model(url) and places them in scene(t)
// like layers: MESH.at(x, y, z, { rx, ry, rz, s, ...material }), or MESH.many(instances, material) for hundreds.
//
// Geometry is { pos, nrm, uv, idx } (Float32Array xyz, xyz, uv; Uint32Array triangles). The generators below make the
// shapes motion graphics are built from: rounded boxes, spheres, and sweep() (a profile swept along a path), which
// makes arches, frames, rings, pipes and rods. Materials (see material()) are Blender's Principled BSDF, by the names of
// its inputs. Boxes and spheres also carry their solid form (geo.solid: half extents and edge radius), so glass made of
// them can follow light through their inside, and reflections meet them exactly.
import { settle, motionsUsed, STACKS } from './motion.js';
import { here } from './site.js';

/** Colour as linear rgb from CSS hex ('#ffd23f'), or [r, g, b] in sRGB 0–1 (how colours are picked). */
export function rgb(c) {
  if (c == null) return null;
  const s = typeof c === 'string' ? hex(c) : c;
  return s.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
}
const hex = (h) => { const x = h.replace('#', ''), f = x.length === 3 ? [...x].map((d) => d + d) : x.match(/../g); return f.slice(0, 3).map((d) => parseInt(d, 16) / 255); };

/**
 * A material from a node's options: Blender's Principled BSDF, its inputs named as Blender names them (camelCase), with
 * Blender's defaults (but a white base colour). Colours are CSS hex or sRGB [r, g, b] 0–1.
 *   baseColor, metallic (0), roughness (0.5), ior (1.5)
 *   specularIorLevel (0.5: as the ior says; 0 none, 1 twice), specularTint (white: a dielectric's reflection head-on, a
 *     metal's at grazing angles)
 *   transmissionWeight (0; 1 is glass: what is behind is seen through it, bent by its ior, frosted by its roughness,
 *     tinted by its base colour), dispersion (0–1: colours split at the bends, a few px at most)
 *   coatWeight (0), coatRoughness (0.03), coatIor (1.5), coatTint (white): a clear layer over it all (lacquer, car paint)
 *   sheenWeight (0), sheenRoughness (0.5), sheenTint (white): a soft glow at grazing angles (velvet, fabric, peach fuzz)
 *   emissionColor (white), emissionStrength (0): its own light (blooms with post.bloom)
 *   thinFilmThickness (nm; 0, none), thinFilmIor (1.33): interference colours sliding with the angle (soap, oil, coated
 *     glass); its reflection takes them and what passes through it the rest
 * and Ephemeris's own:
 *   attenuationColor (white), attenuationDistance (400): glass's colour after that many px inside it, so long paths and
 *     thick edges go deeper (glTF's volume; Blender's Volume Absorption)
 *   thickness (20): glass that is not a box or sphere is a pane this thick; bounces (4): how many other pieces of glass
 *     its light passes on through (0: it sees through them as if they were not there)
 *   iridescence (0–1): a stylized dichroic film (the GitHub tunnel's glass): colours that slide with the angle and sweep
 *     across its faces in bands; its reflection takes them, and what passes through it their complement
 *   rim, rimPower (3): a coloured silhouette
 *   normalStrength (1): how far its mesh's normal map bends it (Blender's Normal Map node's Strength: 0 not at all, past
 *     1 further; see Mesh's normalMap)
 * Not here: subsurface, anisotropy, alpha.
 */
const RENAMED = { color: 'baseColor', emissive: 'emissionColor', glow: 'emissionStrength', glass: 'transmissionWeight: 1 (with ior, dispersion, roughness, attenuationColor, attenuationDistance, thickness, bounces)',
  tint: 'attenuationColor', depth: 'attenuationDistance', opacity: 'nothing: meshes are opaque' };
export function material(o = {}) {
  for (const k in RENAMED) if (k in o) throw new Error(`material: "${k}" is now ${RENAMED[k]} (Blender's Principled BSDF names; see material() in engine/mesh.js)`);
  const c = (v, d) => rgb(v ?? d), t = o.transmissionWeight ?? 0;
  return {
    baseColor: c(o.baseColor, '#ffffff'), metallic: o.metallic ?? 0, roughness: o.roughness ?? 0.5, ior: o.ior ?? 1.5,
    specularIorLevel: o.specularIorLevel ?? 0.5, specularTint: c(o.specularTint, '#ffffff'),
    transmissionWeight: t, dispersion: o.dispersion ?? 0,
    coatWeight: o.coatWeight ?? 0, coatRoughness: o.coatRoughness ?? 0.03, coatIor: o.coatIor ?? 1.5, coatTint: c(o.coatTint, '#ffffff'),
    sheenWeight: o.sheenWeight ?? 0, sheenRoughness: o.sheenRoughness ?? 0.5, sheenTint: c(o.sheenTint, '#ffffff'),
    emission: c(o.emissionColor, '#ffffff').map((v) => v * (o.emissionStrength ?? 0)),
    thinFilmThickness: o.thinFilmThickness ?? 0, thinFilmIor: o.thinFilmIor ?? 1.33,
    // how much each channel is absorbed per px inside (Beer–Lambert: what is left after attenuationDistance px)
    absorb: c(o.attenuationColor, '#ffffff').map((v) => -Math.log(Math.max(v, 1e-3)) / (o.attenuationDistance ?? 400)),
    thickness: o.thickness ?? 20, bounces: o.bounces ?? 4, iridescence: o.iridescence ?? 0,
    rim: c(o.rim, '#000000'), rimPower: o.rimPower ?? 3, normalStrength: o.normalStrength ?? 1,
    glass: t > 0,   // drawn (and traced through) as glass
  };
}

export class Mesh {
  /**
   * @param geo {{ pos: Float32Array, nrm: Float32Array, uv?: Float32Array, idx: Uint32Array }}
   * @param o.texture  a base colour texture: an ImageBitmap, or its mip chain (largest first)
   * @param o.normalMap  a normal map on its uv, as Blender and glTF make them (tangent space, green up the picture,
   *   its values as stored: load it with colorSpaceConversion 'none', as gltf.js's mips() does): an ImageBitmap or its
   *   mip chain; it bends the mesh's normals as material's normalStrength says, wherever the mesh is seen (not on glass)
   * @param o.material  material options every node of this mesh starts from (a model's own colour and finish)
   */
  constructor(geo, { label = '', texture = null, normalMap = null, material: defaults = {} } = {}) {
    this.label = label; this.gpu = null;
    this.set({ geo, texture, normalMap, material: defaults });
  }
  /** Gives the mesh its geometry (a model's, once loaded). */
  set({ geo, texture = null, normalMap = null, material: defaults = {} }) {
    this.geo = geo; this.texture = texture; this.normalMap = normalMap; this.defaults = defaults; this.gpu = null; this.solid = geo.solid ?? null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < geo.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], geo.pos[i + k]); hi[k] = Math.max(hi[k], geo.pos[i + k]); }
    this.bounds = [lo, hi];
  }
  /** A scene node: this mesh at world (x, y, z), turned rx, ry, rz degrees (X, then Y, then Z), scaled s (or [sx, sy, sz]). */
  at(x, y, z = 0, o = {}) {
    // (a value given as a motion is its value now, and the copy remembers it: the editor shows its lanes)
    const from = motionsUsed() ? {} : null;
    if (from) { ({ x, y, z } = settle({ x, y, z }, from)); o = settle(o, from); }
    const it = { x, y, z, rx: o.rx, ry: o.ry, rz: o.rz, s: o.s };
    if (from && Object.keys(from).length) it[STACKS] = from;
    const [surface, mo] = withSurface({ ...this.defaults, ...o });
    return { mesh: this, instances: [it], material: material(mo), surface, options: o, label: o.label ?? this.label, ...placed(this) };
  }
  /** One node drawing many copies: [{ x, y, z, rx, ry, rz, s, baseColor }] (each copy's base colour times the material's), sharing a material. */
  many(list, o = {}) {
    if (list[0] && 'color' in list[0]) throw new Error(`many(): a copy's "color" is now baseColor (Blender's Principled BSDF names)`);
    if (motionsUsed()) {
      // (a fresh record only for a copy that had a motion in it, a new list only if one did: spring-brutalist's 24,000 copies, 9 times a frame)
      let was = {}, out = null;
      for (let i = 0; i < list.length; i++) {
        const it = list[i], v = settle(it, was);
        if (v === it) continue;
        v[STACKS] = was; was = {};
        (out ??= [...list])[i] = v;
      }
      if (out) list = out;
      const from = {};
      o = settle(o, from);
      if (Object.keys(from).length) { const [surface, mo] = withSurface({ ...this.defaults, ...o }); return { mesh: this, instances: list, material: material(mo), surface, options: o, label: o.label ?? this.label, [STACKS]: from, ...placed(this) }; }
    }
    const [surface, mo] = withSurface({ ...this.defaults, ...o });
    return { mesh: this, instances: list, material: material(mo), surface, options: o, label: o.label ?? this.label, ...placed(this) };
  }
}
// a surface of the film's own (F.surface, see surface.js), given as `surface` with its params beside it: the surface and
// its params (its defaults where not given), and what is left for the material
function withSurface(o) {
  const S = o.surface;
  if (!S) return [null, o];
  if (!S.defaults || !S.mode) throw new Error('a mesh\'s surface is one F.surface() made');
  const params = { ...S.defaults }, rest = {};
  for (const [k, v] of Object.entries(o)) { if (k === 'surface') continue; if (k in S.defaults) params[k] = v; else rest[k] = v; }
  return [{ of: S, params }, rest];
}
/** Where the film's code placed a node of `of` (its site), while the editor asks (picking: see runtime.js): every
 *  node's, or (__sites: a set of things) only those placing one of them, and those placing nothing named. */
export const placed = (of) => { const want = globalThis.__sites; return want && (want === true || !of || want.has(of)) ? { site: here() } : null; };
export const EMPTY = { pos: new Float32Array(3), nrm: new Float32Array([0, 0, 1]), uv: new Float32Array(2), idx: new Uint32Array(0) };

// ---------------------------------------------------------------- shapes

/** A box w x h x d, its edges rounded to radius r with `seg` steps (a hard box with r = 0). Centred on the origin. */
export function box({ w = 100, h = w, d = w, r = 0, seg = 6 } = {}) {
  r = Math.max(0, Math.min(r, w / 2, h / 2, d / 2));
  const inner = [w / 2 - r, h / 2 - r, d / 2 - r];
  // a face's grid lines along one axis, crowded into the rounded edges so each step turns the same angle
  const lines = (i) => {
    if (!r) return [-i, i];
    const a = [], b = [];
    for (let j = 0; j <= seg; j++) { a.push(-i - r * Math.tan((Math.PI / 4) * (1 - j / seg))); b.push(i + r * Math.tan((Math.PI / 4) * (j / seg))); }
    return [...a, ...b];
  };
  const G = builder();
  for (let ax = 0; ax < 3; ax++) for (const s of [-1, 1]) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3, Lu = lines(inner[u]), Lv = lines(inner[v]);
    const row = [];
    for (const cv of Lv) for (const cu of Lu) {
      const p = [0, 0, 0]; p[ax] = s * (inner[ax] + r); p[u] = cu; p[v] = cv;
      const q = p.map((c, k) => Math.max(-inner[k], Math.min(inner[k], c)));
      let n = p.map((c, k) => c - q[k]);
      if (!r) n = [0, 0, 0].map((_, k) => (k === ax ? s : 0));
      const len = Math.hypot(...n); n = n.map((c) => c / len);
      row.push(G.vert(r ? q.map((c, k) => c + n[k] * r) : p, n, [(cu - Lu[0]) / (Lu.at(-1) - Lu[0]), (cv - Lv[0]) / (Lv.at(-1) - Lv[0])]));
    }
    G.grid(row, Lu.length, Lv.length, s < 0);
  }
  return { ...G.done(), solid: { half: [w / 2, h / 2, d / 2], r } };
}

/** A sphere of radius r. */
export function sphere({ r = 50, seg = 24 } = {}) {
  const G = builder(), row = [], nu = seg * 2, nv = seg;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const th = (j / nv) * Math.PI, ph = (i / nu) * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), -Math.cos(th), Math.sin(th) * Math.sin(ph)];
    row.push(G.vert(n.map((c) => c * r), n, [i / nu, j / nv]));
  }
  G.grid(row, nu + 1, nv + 1, true);
  return { ...G.done(), solid: { half: [r, r, r], r } };
}

/** A rounded rectangle w x h (corner radius r) as a closed profile: [[u, v], …] and outward normals. */
export function roundRect(w, h, r = 0, seg = 6) {
  r = Math.min(r, w / 2, h / 2);
  const pts = [], nrm = [], cs = [[w / 2 - r, h / 2 - r, 0], [-(w / 2 - r), h / 2 - r, 90], [-(w / 2 - r), -(h / 2 - r), 180], [w / 2 - r, -(h / 2 - r), 270]];
  for (const [cx, cy, a0] of cs) for (let j = 0; j <= seg; j++) {
    const a = ((a0 + (90 * j) / seg) * Math.PI) / 180, n = [Math.cos(a), Math.sin(a)];
    pts.push([cx + n[0] * r, cy + n[1] * r]); nrm.push(n);
  }
  return { pts, nrm };
}
/** A circle of radius r as a closed profile. */
export function circle(r, seg = 24) {
  const pts = [], nrm = [];
  for (let j = 0; j < seg; j++) { const a = (j / seg) * Math.PI * 2, n = [Math.cos(a), Math.sin(a)]; pts.push([n[0] * r, n[1] * r]); nrm.push(n); }
  return { pts, nrm };
}

/**
 * A profile (roundRect(), circle()) swept along a path of [x, y, z] points: the profile's u runs across the path in its
 * plane, v along `up` (default z, so a path drawn in the xy plane gives a shape with depth). Open paths get flat caps.
 */
export function sweep({ path, profile, closed = false, up = [0, 0, 1], caps = true }) {
  const G = builder(), n = path.length, m = profile.pts.length;
  const sub = (a, b) => a.map((c, k) => c - b[k]), norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((c) => c / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const T = path.map((p, i) => norm(closed ? sub(path[(i + 1) % n], path[(i - 1 + n) % n]) : sub(path[Math.min(i + 1, n - 1)], path[Math.max(i - 1, 0)])));
  const B = T.map((t) => { const d = up[0] * t[0] + up[1] * t[1] + up[2] * t[2]; return norm(up.map((c, k) => c - t[k] * d)); });
  const N = T.map((t, i) => cross(B[i], t));
  // the length along the path, for uv
  const len = [0]; for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(...sub(path[i], path[i - 1])));
  const total = closed ? len[n - 1] + Math.hypot(...sub(path[0], path[n - 1])) : len[n - 1];
  const at = (i, j) => { const [u, v] = profile.pts[j], [nu, nv] = profile.nrm[j]; return [path[i].map((c, k) => c + N[i][k] * u + B[i][k] * v), N[i].map((c, k) => c * nu + B[i][k] * nv)]; };
  const row = [], rows = closed ? n + 1 : n;
  for (let ii = 0; ii < rows; ii++) {
    const i = ii % n;
    for (let jj = 0; jj <= m; jj++) { const [p, nn] = at(i, jj % m); row.push(G.vert(p, nn, [jj / m, (ii < n ? len[i] : total) / total])); }
  }
  G.grid(row, m + 1, rows, false);
  if (!closed && caps) for (const [i, s] of [[0, -1], [n - 1, 1]]) {
    const nn = T[i].map((c) => c * s), c0 = G.vert(path[i], nn, [0.5, 0.5]);
    const ring = profile.pts.map((_, j) => G.vert(at(i, j)[0], nn, [0.5, 0.5]));
    for (let j = 0; j < m; j++) G.tri(c0, ring[j], ring[(j + 1) % m], s > 0);
  }
  return G.done();
}

/** A ring: a torus of radius R whose tube is the profile (default a circle of radius r). */
export function torus({ R = 100, r = 20, profile = circle(r), seg = 64 } = {}) {
  const path = Array.from({ length: seg }, (_, i) => { const a = (i / seg) * Math.PI * 2; return [Math.cos(a) * R, Math.sin(a) * R, 0]; });
  return sweep({ path, profile, closed: true });
}
/**
 * An arch standing on y = 0 (y up is negative): legs w apart (outer), h tall, its band t wide and d deep, its edges
 * rounded r. A frame is the closed version: frame().
 */
export function arch({ w = 300, h = 400, t = 60, d = 60, r = 12, seg = 24 } = {}) {
  const R = (w - t) / 2, top = h - t / 2, spring = top - R, path = [];
  for (let i = 0; i <= 4; i++) path.push([-R, -spring * (i / 4), 0]);
  for (let i = 1; i < seg; i++) { const a = Math.PI + (i / seg) * Math.PI; path.push([Math.cos(a) * R, -spring + Math.sin(a) * R, 0]); }
  for (let i = 0; i <= 4; i++) path.push([R, -spring * (1 - i / 4), 0]);
  return sweep({ path, profile: roundRect(t, d, r) });
}
/** A rectangular frame w x h (outer), its band t wide and d deep, corners turned with radius cr, edges rounded r. */
export function frame({ w = 300, h = 300, t = 40, d = 40, r = 8, cr = t, seg = 8 } = {}) {
  const a = w / 2 - t / 2, b = h / 2 - t / 2, c = Math.min(cr, a, b) || 0.001, path = [];
  for (const [cx, cy, a0] of [[a - c, b - c, 0], [-(a - c), b - c, 90], [-(a - c), -(b - c), 180], [a - c, -(b - c), 270]]) {
    for (let j = 0; j <= seg; j++) { const ang = ((a0 + (90 * j) / seg) * Math.PI) / 180; path.push([cx + Math.cos(ang) * c, cy + Math.sin(ang) * c, 0]); }
  }
  return sweep({ path, profile: roundRect(t, d, r), closed: true });
}
/** A cylinder (a rod) of radius r and length h along y, centred, with caps. */
export function cylinder({ r = 40, h = 200, seg = 32 } = {}) {
  return sweep({ path: [[0, h / 2, 0], [0, 0, 0], [0, -h / 2, 0]], profile: circle(r, seg), up: [0, 0, 1] });
}

/** A plane w across x and d across z, flat on y = 0, facing up (y up is negative). Centred on the origin. */
export function plane({ w = 100, d = w } = {}) {
  const G = builder(), up = [0, -1, 0];
  const c = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]].map(([x, z], i) => G.vert([x, 0, z], up, [i % 2, i >> 1]));
  G.grid(c, 2, 2, true);
  return G.done();
}
/** A cone of radius r and height h along y, its tip up (y up is negative), its base closed. Centred. */
export function cone({ r = 50, h = 100, seg = 48 } = {}) {
  const G = builder(), l = Math.hypot(r, h), ring = (i) => { const a = (i / seg) * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
  for (let i = 0; i < seg; i++) {
    const [ca, sa] = ring(i), [cb, sb] = ring(i + 1), [cm, sm] = ring(i + 0.5);
    const n = (c, s) => [(c * h) / l, -r / l, (s * h) / l];
    G.tri(G.vert([0, -h / 2, 0], n(cm, sm), [(i + 0.5) / seg, 0]), G.vert([cb * r, h / 2, sb * r], n(cb, sb), [(i + 1) / seg, 1]), G.vert([ca * r, h / 2, sa * r], n(ca, sa), [i / seg, 1]));
    const c0 = G.vert([0, h / 2, 0], [0, 1, 0], [0.5, 0.5]);
    G.tri(c0, G.vert([ca * r, h / 2, sa * r], [0, 1, 0], [0.5 + ca / 2, 0.5 + sa / 2]), G.vert([cb * r, h / 2, sb * r], [0, 1, 0], [0.5 + cb / 2, 0.5 + sb / 2]));
  }
  return G.done();
}

/** Several geometries as one (each already placed). */
export function merge(...gs) {
  const G = builder();
  for (const g of gs) {
    const base = G.count();
    for (let i = 0; i < g.pos.length / 3; i++) G.vert([g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]], [g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]], g.uv ? [g.uv[i * 2], g.uv[i * 2 + 1]] : [0, 0]);
    for (let i = 0; i < g.idx.length; i++) G.raw(base + g.idx[i]);
  }
  return G.done();
}
/** Geometry moved by (x, y, z) and scaled s (a number or [sx, sy, sz]). */
export function place(g, x = 0, y = 0, z = 0, s = 1) {
  const S = Array.isArray(s) ? s : [s, s, s], pos = new Float32Array(g.pos), nrm = new Float32Array(g.nrm);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = pos[i] * S[0] + x; pos[i + 1] = pos[i + 1] * S[1] + y; pos[i + 2] = pos[i + 2] * S[2] + z;
    const n = [nrm[i] / S[0], nrm[i + 1] / S[1], nrm[i + 2] / S[2]], l = Math.hypot(...n) || 1;
    nrm[i] = n[0] / l; nrm[i + 1] = n[1] / l; nrm[i + 2] = n[2] / l;
  }
  return { pos, nrm, uv: g.uv, idx: g.idx };
}

function builder() {
  const pos = [], nrm = [], uv = [], idx = [];
  const G = {
    vert(p, n, t) { pos.push(...p); nrm.push(...n); uv.push(...t); return pos.length / 3 - 1; },
    tri(a, b, c, flip) { if (flip) idx.push(a, c, b); else idx.push(a, b, c); },
    raw(i) { idx.push(i); },
    count: () => pos.length / 3,
    // quads over a grid of vertex ids (nu across, nv down)
    grid(ids, nu, nv, flip) {
      for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
        const a = ids[j * nu + i], b = ids[j * nu + i + 1], c = ids[(j + 1) * nu + i], d = ids[(j + 1) * nu + i + 1];
        G.tri(a, b, d, flip); G.tri(a, d, c, flip);
      }
    },
    done: () => ({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) }),
  };
  return G;
}

// a copy's colour as linear rgb, each CSS hex read once (a scene of thousands of copies in a handful of colours reads
// the same few strings every sub-frame); a film that makes a new colour every frame empties it now and then
const linear = new Map(), WHITE = [1, 1, 1];
function copyColor(c) {
  if (typeof c !== 'string') return rgb(c);
  let v = linear.get(c);
  if (!v) { if (linear.size >= 4096) linear.clear(); linear.set(c, (v = rgb(c))); }
  return v;
}

/** Per-instance transform rows for the compositor: the model matrix (3 columns, translation in w), the normal matrix, colour. */
export function instanceData(list, out, offset) {
  // (nothing allocated for a copy: a film may have tens of thousands, several times a frame)
  for (let k = 0; k < list.length; k++) {
    const it = list[k], s = it.s, many = Array.isArray(s);
    const s0 = many ? s[0] : s ?? 1, s1 = many ? s[1] : s ?? 1, s2 = many ? s[2] : s ?? 1;
    const ax = ((it.rx ?? 0) * Math.PI) / 180, ay = ((it.ry ?? 0) * Math.PI) / 180, az = ((it.rz ?? 0) * Math.PI) / 180;
    const cx = ax ? Math.cos(ax) : 1, sx = ax ? Math.sin(ax) : 0, cy = ay ? Math.cos(ay) : 1, sy = ay ? Math.sin(ay) : 0, cz = az ? Math.cos(az) : 1, sz = az ? Math.sin(az) : 0;
    // R = Rz · Ry · Rx (rx applied first, as for layers)
    const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx;
    const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx;
    const r20 = -sy, r21 = cy * sx, r22 = cy * cx;
    const o = offset + k * 28, c = it.baseColor ? copyColor(it.baseColor) : WHITE;
    out[o] = r00 * s0; out[o + 1] = r10 * s0; out[o + 2] = r20 * s0;
    out[o + 4] = r01 * s1; out[o + 5] = r11 * s1; out[o + 6] = r21 * s1;
    out[o + 8] = r02 * s2; out[o + 9] = r12 * s2; out[o + 10] = r22 * s2;
    out[o + 12] = r00 / s0; out[o + 13] = r10 / s0; out[o + 14] = r20 / s0; out[o + 15] = 0;
    out[o + 16] = r01 / s1; out[o + 17] = r11 / s1; out[o + 18] = r21 / s1; out[o + 19] = 0;
    out[o + 20] = r02 / s2; out[o + 21] = r12 / s2; out[o + 22] = r22 / s2; out[o + 23] = 0;
    out[o + 3] = it.x ?? 0; out[o + 7] = it.y ?? 0; out[o + 11] = it.z ?? 0;
    out[o + 24] = c[0]; out[o + 25] = c[1]; out[o + 26] = c[2]; out[o + 27] = 1;
  }
}
export const INSTANCE_FLOATS = 28;
