// What the director can add by hand (engine/things.js keeps what each is), and where a new one lands: where the viewer's
// camera looks, sized for the frame there, so that it shows at once wherever the camera is.
import { basis } from '/files/engine/lens.js';

export const ADD = [
  { type: 'cube', label: 'Cube', icon: 'cube' }, { type: 'sphere', label: 'Sphere', icon: 'sphere' }, { type: 'plane', label: 'Plane', icon: 'square' },
  { type: 'cylinder', label: 'Cylinder', icon: 'cylinder' }, { type: 'cone', label: 'Cone', icon: 'triangle' }, { type: 'torus', label: 'Torus', icon: 'disc' },
  { type: 'point', label: 'Point light', icon: 'lightbulb', light: true }, { type: 'spot', label: 'Spot light', icon: 'flashlight', light: true }, { type: 'sun', label: 'Sun light', icon: 'sun', light: true },
];
export const isLightType = (type) => ADD.some((a) => a.type === type && a.light);
export const iconOf = (type) => ADD.find((a) => a.type === type)?.icon ?? 'cube';
const CLAY = { baseColor: '#c8ccd2', roughness: 0.55 };
const round = (v, d = 1) => Math.round(v * d) / d;
const deg = (r) => (r * 180) / Math.PI;
// the turn that takes a light's way (straight down: engine/things.js) to the unit way u
const aimedAt = (u) => ({ rx: round(deg(Math.asin(Math.max(-1, Math.min(1, u[2])))), 10), ry: 0, rz: round(deg(Math.atan2(-u[0], u[1])), 10) });

// point p drawn back along its line to the frame's centre c, far enough to show in the middle of what the view shows of the
// frame (seen: { w, h }, frame px) and to stay well in front of the lens: a light can be grabbed only where it shows
function inView(p, c, B, zoom, seen) {
  const o = p.map((v, k) => v - c[k]), dot = (a) => a[0] * o[0] + a[1] * o[1] + a[2] * o[2], far = B.focal / zoom, near = dot(B.back);
  // (the most of o that keeps its offset on the frame, focal × across / depth, within reach)
  const most = (across, reach) => { const d = B.focal * Math.abs(across) + reach * near; return d > 0 ? (reach * far) / d : 1; };
  const s = Math.min(1, most(dot(B.right), seen.w * VIEW_REACH), most(dot(B.down), seen.h * VIEW_REACH), near > 0 ? (0.75 * far) / near : 1);
  return c.map((v, k) => v + o[k] * s);
}
const VIEW_REACH = 0.35;   // (of what shows across, from its middle: its edges are half)

/** A new thing of `type` as the timeline keeps it (without its label), seen by camera `cam` on a frame fh px high, of which
 *  `seen` shows ({ w, h }, frame px: the Director view crops the frame to fill its panel). */
export function newThing(type, cam, fh, seen) {
  const B = basis(cam), c = B.center, zoom = cam.zoom || 1, h = fh / zoom, at = (p) => ({ x: round(p[0]), y: round(p[1]), z: round(p[2]) });
  if (isLightType(type)) {
    // (above what the camera looks at, on the frame, and toward the camera; bright enough there to read at once)
    const d = h * 0.6, p = inView([c[0] + B.back[0] * d * 0.4, c[1] - d * 0.5, c[2] + B.back[2] * d * 0.4], c, B, zoom, seen), to = c.map((v, k) => v - p[k]), l = Math.hypot(...to) || 1, u = to.map((v) => v / l);
    const radius = round(d * 0.04), bright = (k) => +(k * (l / 1000) ** 2).toPrecision(3);
    if (type === 'point') return { type, ...at(p), color: '#ffffff', intensity: bright(2), radius, shadows: true };
    if (type === 'spot') return { type, ...at(p), ...aimedAt(u), color: '#ffffff', intensity: bright(4), radius, angle: 40, soft: 0.4, shadows: true };
    const way = B.right.map((v, k) => v * 0.5 + B.down[k] - B.back[k] * 0.6), wl = Math.hypot(...way), su = way.map((v) => v / wl);
    return { type, ...at(inView(c.map((v, k) => v - su[k] * d), c, B, zoom, seen)), ...aimedAt(su), color: '#ffffff', intensity: 1.5, angle: 4, shadows: true };
  }
  const s = Math.max(0.01, round((h * (type === 'plane' ? 0.7 : 0.3)) / 100, 100));
  // (a plane lies on the floor, unless the camera looks along the floor and would see only its edge: then it faces the camera)
  const facing = type === 'plane' && Math.abs(B.back[1]) < 0.1 ? { rx: -90, ry: round(cam.yaw ?? 0, 10) } : {};
  return { type, ...at(c), ...facing, sx: s, sy: s, sz: s, ...CLAY };
}

/** What the material menu offers: each what it sets of a material's inputs. */
export const MATERIALS = [
  { label: 'Matte', set: { metallic: 0, roughness: 0.7, transmissionWeight: 0, emissionStrength: 0 } },
  { label: 'Glossy', set: { metallic: 0, roughness: 0.15, transmissionWeight: 0, emissionStrength: 0 } },
  { label: 'Metal', set: { metallic: 1, roughness: 0.25, transmissionWeight: 0, emissionStrength: 0 } },
  { label: 'Glass', set: { metallic: 0, roughness: 0.02, transmissionWeight: 1, emissionStrength: 0 } },
  { label: 'Glow', set: { metallic: 0, roughness: 0.7, transmissionWeight: 0, emissionStrength: 4 } },
];
