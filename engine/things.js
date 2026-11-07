// What the director adds by hand in the studio: a shape to block something out, or a light. Each is a clip of the timeline
// with a `thing` saying what it is (nle/model.js); the film's scene has it for as long as the clip plays. It has the name
// clip:<id> where the code's things have the line that placed them, so the viewer, the gizmo, the inspector and the lanes
// treat it as any placed thing, and what the director changes on it (where it is, its material, its keys) is in the
// timeline's overrides as for those. The `thing`:
//   { type: 'cube' | 'sphere' | 'plane' | 'cylinder' | 'cone' | 'torus', label, x, y, z, rx, ry, rz, sx, sy, sz, …material }
//     each shape 100 px across before its scale
//   { type: 'point' | 'spot' | 'sun', label, x, y, z, rx, ry, rz, color, intensity, radius, angle, soft, range, shadows }
//     its way straight down before its turn
//   { of: { at, nth, key, like, copy } | { sites }, label, x, y, z }
//     a linked copy of what the code places (a duplicate of it), moved by x, y, z: it moves as that does, and is where
//     that is in the scene
import { Mesh, box, sphere, plane, cylinder, cone, torus } from './mesh.js';
import { Light, turned } from './light.js';
import { STACKS } from './motion.js';
import { siteOf } from './site.js';

export const SHAPES = { cube: () => box({ w: 100 }), sphere: () => sphere({ r: 50 }), plane: () => plane({ w: 100 }), cylinder: () => cylinder({ r: 50, h: 100 }), cone: () => cone({ r: 50, h: 100 }), torus: () => torus({ R: 37.5, r: 12.5 }) };
export const LIGHTS = ['point', 'spot', 'sun'];
const DOWN = [0, 1, 0];

// (one mesh and one light each, however many are placed: a mesh's geometry is kept once)
const meshes = new Map(), lights = new Map();
const meshOf = (type) => { if (!meshes.has(type)) meshes.set(type, new Mesh(SHAPES[type](), { label: type })); return meshes.get(type); };
const lightOf = (type) => { if (!lights.has(type)) lights.set(type, new Light(type)); return lights.get(type); };
const nameOf = (type) => type[0].toUpperCase() + type.slice(1);

// a copy that keeps no motion of the code's: its lanes are its own, over what the code gives it
const own = (x, dx, dy, dz) => { const c = { ...x, x: (x.x ?? 0) + dx, y: (x.y ?? 0) + dy, z: (x.z ?? 0) + dz }; delete c[STACKS]; delete c.__orig; return c; };
function copied(n, dx, dy, dz, label) {
  const c = n.instances ? { ...n, instances: n.instances.map((it) => own(it, dx, dy, dz)) } : own(n, dx, dy, dz);
  delete c[STACKS];
  delete c.nth;
  if (n.aim) c.aim = [n.aim[0] + dx, n.aim[1] + dy, n.aim[2] + dz];
  if (label) c.label = label;
  return c;
}
// what a linked copy copies, in the code's scene: the nodes its sites place, or the one node and copy it names
function copiesOf(of, nodes, match) {
  const at = (n) => siteOf(n?.site)?.at;
  if (of.sites) { const sites = new Set(of.sites); return nodes.filter((n) => sites.has(at(n))); }
  let seen = -1;
  const n = nodes.find((x) => at(x) === of.at && ++seen === (of.nth ?? 0));
  if (!n?.instances || n.instances.length === 1) return n ? [n] : [];
  const k = match(n.instances, of);
  return k < 0 ? [] : [{ ...n, instances: [n.instances[k]] }];
}

/** The scene's nodes for an added thing's clip, given the nodes the code placed at this moment; match: pick.js matchCopy. */
export function thingNodes(clip, nodes, match) {
  const th = clip.thing, site = { at: `clip:${clip.id}`, file: null, line: null, col: null, clip: clip.id, added: true };
  const { type, label, of, x = 0, y = 0, z = 0, rx, ry, rz, sx = 1, sy = 1, sz = 1, ...rest } = th;
  if (of) return copiesOf(of, nodes, match).map((n) => ({ ...copied(n, x, y, z, label), site, added: true }));
  if (LIGHTS.includes(type)) return [{ ...lightOf(type).at(x, y, z, { ...rest, label: label ?? nameOf(type), dir: turned(DOWN, rx, ry, rz) }), rx, ry, rz, dir0: DOWN, site, added: true }];
  if (!SHAPES[type]) return [];
  return [{ ...meshOf(type).at(x, y, z, { ...rest, rx, ry, rz, s: [sx, sy, sz], label: label ?? nameOf(type) }), site, added: true }];
}
