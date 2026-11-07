// A property over time, as the editor's overrides keep one (see overrides.js): a value, or keyframes [{ t, v }] — from
// each to the next eased as a camera's .to() is (glide), held before the first and after the last. Numbers and
// colours (CSS hex or [r, g, b]) ease; anything else holds. Plain, so the editor shares it.
import { glide } from './ease.js';

const rgbOf = (c) => (typeof c === 'string' ? (c.replace('#', '').match(/../g) ?? []).slice(0, 3).map((d) => parseInt(d, 16) / 255) : c);
export const keyed = (v) => Array.isArray(v) && v.length > 0 && v[0] != null && typeof v[0] === 'object' && 't' in v[0];
/** The value at t. */
export function valueAt(v, t) {
  if (!keyed(v)) return v;
  const k = [...v].sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  const i = k.findIndex((x) => x.t > t), a = k[i - 1], b = k[i], u = glide((t - a.t) / (b.t - a.t));
  if (typeof a.v === 'number' && typeof b.v === 'number') return a.v + (b.v - a.v) * u;
  const ca = rgbOf(a.v), cb = rgbOf(b.v);
  if (Array.isArray(ca) && Array.isArray(cb)) return ca.map((x, j) => x + (cb[j] - x) * u);
  return u < 1 ? a.v : b.v;
}
