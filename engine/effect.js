// Effects: procedural planes written in WGSL and evaluated per screen pixel, so they stay sharp at any zoom (a
// starfield the camera dives into, a light sweep, a matte). An effect is placed like a layer:
//
//   const sky = effect(`fn effect(uv: vec2f, size: vec2f, t: f32) -> vec4f { ... }`, 'sky');
//   nodes.push(sky.at(x, y, { w: 1600, h: 900, params: [..up to 16 floats] }));
//
// uv spans the plane (0..1, y down), size is its world size, t the film time; params arrive as q.p0..q.p3 (vec4f).
// Return premultiplied rgba. fwidth() of a world-space coordinate gives the on-screen pixel size, for antialiasing.
export function effect(code, label = 'effect') {
  const fx = { code, label };
  fx.at = (x, y, o = {}) => ({ fx, layer: fx, x, y, z: o.z ?? 0, w: o.w, h: o.h, rx: o.rx, ry: o.ry, rz: o.rz, opacity: o.opacity, screen: o.screen, params: o.params });
  return fx;
}
