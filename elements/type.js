// Type on the film clock. Headlines are ordinary DOM (any font, any CSS), animated per line and captured as a
// layer that is live only while it moves.
import { anim, E } from '../engine/time.js';

/**
 * Lines rise in (staggered, from blur) at t and fall out at `out`. Each direct child of `el` is a line.
 * Give the layer `live: span(...)` and enough pad for the rise distance and blur.
 */
export function lines(el, { t, out = Infinity, stagger = 0.08, rise = 0.45, blur = 14 }) {
  [...el.children].forEach((ln, i) => {
    const size = parseFloat(getComputedStyle(ln).fontSize) || 100;
    const ti = t + i * stagger, to = out + i * 0.04;
    const o = [[ti, 0], [ti + 0.4, 1, E.mat]], y = [[ti, size * rise], [ti + 0.75, 0, E.apple]], b = [[ti, blur], [ti + 0.55, 0, E.out2]];
    if (Number.isFinite(out)) { o.push([to, 1], [to + 0.3, 0]); y.push([to, 0], [to + 0.35, -size * 0.25, E.in2]); b.push([to, 0], [to + 0.3, blur * 0.7, E.in2]); }
    anim(ln, 'o', o); anim(ln, 'y', y); anim(ln, 'blur', b);
  });
}

/** The time window a lines() animation needs captured, for a layer's `live` option. */
export const span = (t, out = Infinity, n = 4, stagger = 0.08) => [t - 0.02, Number.isFinite(out) ? out + 0.5 + n * 0.04 : t + 0.9 + n * stagger];

/** Builds a block of lines from strings: <div class=cls><div>line</div>…</div>. */
export function block(texts, cls = '') {
  const el = document.createElement('div');
  el.className = cls;
  for (const s of texts) { const d = document.createElement('div'); d.innerHTML = s; el.append(d); }
  return el;
}
