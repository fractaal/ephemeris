// The pixel filter: how a frame's samples spread round each pixel. Each sample is a sub-frame, the whole frame drawn
// again a fraction of a pixel over (engine/runtime.js), so a pixel's average is the picture seen through the filter.
// Without one (every offset within the pixel: a box), a thin bright edge shows as dots or dashes until many sub-frames
// fill it in. Blackman-Harris (Harris 1978, the minimum four-term window), as Cycles' default: `width` (px, 1.5 by
// default, as Blender's) is how far it reaches either side of the pixel's centre (Cycles' film.cpp doubles the width it
// is given into the window's). Importance-sampled (Ernst, Stamminger and Greiner 2006, filter importance sampling): each
// offset is drawn from the window itself, so every sample weighs the same.

/** The filter's width (px) where the timeline sets none. */
export const PIXEL_FILTER = 1.5;

const A = [0.35875, 0.48829, 0.14128, 0.01168];
// the window's share below q, its phase across it (0 at −width, 2π at width): its integral, in closed form
const share = (q) => (A[0] * q - A[1] * Math.sin(q) + (A[2] * Math.sin(2 * q)) / 2 - (A[3] * Math.sin(3 * q)) / 3) / (2 * Math.PI * A[0]);

/** A sample's offset from the pixel's centre along one axis (px), for a uniform number u in [0, 1): the window's share
 *  below it is u. Type 'box': evenly across the pixel, whatever the width. */
export function filterOffset(u, width = PIXEL_FILTER, type) {
  if (type === 'box') return u - 0.5;
  let lo = 0, hi = 2 * Math.PI;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (share(m) < u) lo = m; else hi = m; }
  return ((lo + hi) / (4 * Math.PI) - 0.5) * 2 * width;
}
