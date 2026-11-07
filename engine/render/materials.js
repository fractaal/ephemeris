// A mesh's material as the shaders read it: one table of every material a scene draws, each laid out by MATERIAL below,
// read the same way by the camera's shader and by every ray (materialAt). The layout is declared once here: the WGSL
// struct, its loader and the JS that packs a material are all made from it, so a new input is one line.

// [name, WGSL type, what it is from a node's material (material() in mesh.js), its mesh and the scene's textures]
// (types: f32, vec3f; a texture is a handle into the texture store: f32, -1 for none)
export const MATERIAL = [
  ['base', 'vec3f', (m) => m.baseColor],
  ['metal', 'f32', (m) => m.metallic],
  ['specTint', 'vec3f', (m) => m.specularTint],
  ['rough', 'f32', (m) => m.roughness],
  ['coatTint', 'vec3f', (m) => m.coatTint],
  ['ior', 'f32', (m) => m.ior],
  ['sheenTint', 'vec3f', (m) => m.sheenTint],
  ['specLevel', 'f32', (m) => m.specularIorLevel],
  ['emit', 'vec3f', (m) => m.emission],
  ['coat', 'f32', (m) => m.coatWeight],
  ['rim', 'vec3f', (m) => m.rim],
  ['coatRough', 'f32', (m) => m.coatRoughness],
  ['absorb', 'vec3f', (m) => m.absorb],
  ['coatIor', 'f32', (m) => m.coatIor],
  ['sheen', 'f32', (m) => m.sheenWeight],
  ['sheenRough', 'f32', (m) => m.sheenRoughness],
  ['transmission', 'f32', (m) => m.transmissionWeight],
  ['dispersion', 'f32', (m) => m.dispersion],
  ['filmThickness', 'f32', (m) => m.thinFilmThickness],
  ['filmIor', 'f32', (m) => m.thinFilmIor],
  ['iridescence', 'f32', (m) => m.iridescence],
  ['rimPower', 'f32', (m) => m.rimPower],
  ['thickness', 'f32', (m) => m.thickness],
  ['bounces', 'f32', (m, x) => x.bounces ?? m.bounces],
  ['normalStrength', 'f32', (m, x) => (x.normalTex >= 0 ? m.normalStrength : 0)],
  ['baseTex', 'f32', (m, x) => x.baseTex],
  ['normalTex', 'f32', (m, x) => x.normalTex],
  // the film's surface (surface.js): its number + 256 × where its params are (0: none)
  ['surface', 'f32', (m, x) => x.surface],
];

const SIZE = { f32: 1, vec3f: 3 };
// each field's place: vec4s filled in order, a vec3f never across two
const layout = (() => {
  let at = 0;
  const fields = MATERIAL.map(([name, type, from]) => {
    const n = SIZE[type];
    if (n === 3 && at % 4 > 1) at = Math.ceil(at / 4) * 4;
    const f = { name, type, from, at, n };
    at += n;
    return f;
  });
  return { fields, vec4s: Math.ceil(at / 4) };
})();
/** How many vec4s a material takes in the scene's table. */
export const MATERIAL_VEC4S = layout.vec4s;

/**
 * A node's material packed as the table holds it, into `out` at float `o`. x: its textures' handles and its surface,
 * and how many pieces of glass its light passes on through where the timeline sets it for every glass (bounces).
 */
export function packMaterial(m, x, out, o) {
  for (const f of layout.fields) {
    const v = f.from(m, x);
    if (f.n === 1) out[o + f.at] = v;
    else out.set(v, o + f.at);
  }
}

const SW = ['x', 'y', 'z', 'w'];
/** The WGSL: struct Material, and materialAt(i), the i-th material of the scene's table (`scn`, from MAT0). */
export const MATERIAL_WGSL = /* wgsl */`
struct Material { ${layout.fields.map((f) => `${f.name}: ${f.type},`).join(' ')} };
fn materialAt(i: i32) -> Material {
  let b = world.tables.materials + i * ${layout.vec4s};
  return Material(${layout.fields.map((f) => `scn[b + ${Math.floor(f.at / 4)}].${SW.slice(f.at % 4, (f.at % 4) + f.n).join('')}`).join(', ')});
}`;

/** A material as the Solid look draws it: its own colour, matte, opaque. */
export const matte = (m) => ({ ...m, metallic: 0, roughness: 0.65, transmissionWeight: 0, glass: false, dispersion: 0, coatWeight: 0, sheenWeight: 0,
  emission: [0, 0, 0], thinFilmThickness: 0, iridescence: 0, rim: [0, 0, 0] });
