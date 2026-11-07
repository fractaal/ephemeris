// The scene's lights, placed as things are: a sun (light from one way, as from far off: a key light, a soft box), a
// point light (a bulb) or a spot (a torch, a stage light) at a world point, lighting the meshes and lit layers around it
// (see engine/render/shaders.js: lightHere, gather); its shadows ray traced where it asks (shadows: true), unshadowed by
// default. Placed with .at() in a scene's nodes, as a mesh or a layer is, so the editor finds it, shows it, and its
// changes (where it is, its intensity, radius, colour, a spot's cone) keep to it:
//   const KEY = F.light('sun', { intensity: 1.3, angle: 4, shadows: true, label: 'key' });
//   push(KEY.at(-800, -900, 800, { aim: [0, 0, 0] }));   // a sun shines from where it is placed toward aim (or dir)
//   const BULB = F.light('point', { color: '#ffb26b', intensity: 0.4, radius: 16, label: 'bulb' });
//   push(BULB.at(x, y, z, { intensity: 0.3 + 0.2 * on }));
//   const SPOT = F.light('spot', { color: '#8fb4ff', intensity: 2, angle: 30, soft: 0.5, radius: 50 });
//   push(SPOT.at(x, y, z, { aim: [0, 0, 0] }));   // pointing at a world point (or dir: the way it points)
// A sun's intensity is how bright a surface facing it is (1: as white as its colour), its angle how large it looks
// (degrees across: 0.5 the real sun's, 30–60 a soft box), so how soft its shadows and highlights are. A point or spot's
// intensity is as bright as that 1000 px away (nearer is brighter, by distance squared); radius (px): its size, so how
// soft its shadows and highlights are (what lies within it, its bulb, does not shadow it); a spot's angle (its cone,
// degrees across) and soft (how much of its edge fades, 0–1); range (px): where it ends (by default where its light,
// with as many as the scene has, would add too little to see: the more lights, the further each reaches); shadows:
// true traces its shadows (by default it has none). Up to 256 a scene: their shadow rays are shared among them by how
// much each lights a point, so many cost about as much as one (the more that light a point brightly, the grainier each
// one's shadow there, until the sub-frames average it).
import { placed } from './mesh.js';
import { settle, motionsUsed, STACKS } from './motion.js';

/** A light's own numbers the editor's lanes can change (beside where it is: x, y, z); its colour is set in place. */
export const LIGHT = ['intensity', 'radius', 'angle', 'soft', 'range'];
/** Which of those a light of a type has: a sun is far off, so it has no size in the world or reach; its angle is how large it looks. */
export const lightNumbers = (type) => LIGHT.filter((k) => (type === 'sun' ? k === 'intensity' || k === 'angle' : type === 'spot' || (k !== 'angle' && k !== 'soft')));
/** The way a light shines as the code placed it (not unit): toward its aim, its dir, or by default straight down (a sun, slanted). */
export const lightWay = (n, at = [n.x ?? 0, n.y ?? 0, n.z ?? 0]) => (n.aim ? n.aim.map((v, k) => v - at[k]) : n.dir ?? (n.light === 'sun' ? [0.45, 1, -0.55] : [0, 1, 0]));
/** A way turned rx, ry, rz degrees (X, then Y, then Z, as a mesh is turned). */
export function turned([x, y, z], rx = 0, ry = 0, rz = 0) {
  const a = (rx * Math.PI) / 180, b = (ry * Math.PI) / 180, c = (rz * Math.PI) / 180;
  const y1 = y * Math.cos(a) - z * Math.sin(a), z1 = y * Math.sin(a) + z * Math.cos(a);
  const x2 = x * Math.cos(b) + z1 * Math.sin(b), z2 = -x * Math.sin(b) + z1 * Math.cos(b);
  return [x2 * Math.cos(c) - y1 * Math.sin(c), x2 * Math.sin(c) + y1 * Math.cos(c), z2];
}
const DEFAULTS = { color: '#ffffff', intensity: 1, radius: 20, soft: 0.25 };

export class Light {
  constructor(type, o = {}) {
    this.type = ['spot', 'sun'].includes(type) ? type : 'point';
    // (angle: a sun's size, a degree across; a spot's cone, 40)
    this.defaults = { ...DEFAULTS, angle: this.type === 'sun' ? 1 : 40, ...o };
    this.label = o.label ?? this.type;
  }
  /** A node lighting the scene from world (x, y, z); o: any of its defaults, for this moment. */
  at(x, y, z = 0, o = {}) {
    // (a value given as a motion is its value now, and the node remembers it: the editor shows its lanes)
    const from = motionsUsed() ? {} : null;
    if (from) { ({ x, y, z } = settle({ x, y, z }, from)); o = settle(o, from); }
    const d = { ...this.defaults, ...o };
    const n = { light: this.type, of: this, x, y, z, color: d.color, intensity: d.intensity, radius: d.radius, angle: d.angle, soft: d.soft,
      dir: d.dir, aim: d.aim, range: d.range, shadows: d.shadows === true, label: o.label ?? this.label, ...placed(this) };
    if (from && Object.keys(from).length) n[STACKS] = from;
    return n;
  }
}
