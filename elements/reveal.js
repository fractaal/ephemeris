// Rows that arrive one by one: each collapses to zero height and grows in at its time (the gap below it included),
// so the content around it reflows as it would in the app. hidden(t) is how much height has not arrived yet — a
// transcript that grows at its end keeps its end in place by scrolling by that much.
import { anim, E, clamp } from '../engine/time.js';

/** rows: elements in a layer (res: the layer's res); times: when each arrives. Call once layout is in (ready()). */
export function reveal(rows, times, { res = 1, dur = 0.42 } = {}) {
  const heights = [], gaps = [];
  rows.forEach((s, i) => {
    if (!s) return;
    const r = s.getBoundingClientRect(), next = rows[i + 1]?.getBoundingClientRect();
    heights[i] = r.height / res;
    gaps[i] = next ? (next.top - r.bottom) / res : 0;
  });
  rows.forEach((s, i) => {
    if (!s) return;
    const t0 = times[i];
    s.style.overflow = 'hidden';
    s.style.boxSizing = 'border-box';
    anim(s, 'h', [[t0 - 0.001, 0], [t0 + dur, heights[i], E.apple]]);
    anim(s, 'o', [[t0, 0], [t0 + 0.3, 1, E.mat]]);
    anim(s, 'css:margin-bottom', [[0, `${-gaps[i]}px`], [t0 - 0.001, `${-gaps[i]}px`], [t0, '0px']]);
  });
  const hidden = (t) => rows.reduce((a, r, i) => a + (r ? (heights[i] + gaps[i]) * (1 - E.apple(clamp((t - times[i]) / 0.45))) : 0), 0);
  return { heights, gaps, hidden };
}
