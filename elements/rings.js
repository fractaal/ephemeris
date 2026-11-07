// Pulse rings: concentric rings that swell out from a point and fade, one pulse per beat of something ringing or
// calling for attention. age: seconds since this pulse began.
import { E, clamp } from '../engine/time.js';
import { css, LIME } from './css.js';

export function rings(F, { size = 520, color = LIME, res = 1.5 } = {}) {
  css('rings', `.eph-rings { position: relative; }
.eph-rings i { position: absolute; border-radius: 50%; }
.eph-rings i:nth-child(2) { opacity: .7; }
.eph-rings i:nth-child(3) { opacity: .45; }`);
  const el = document.createElement('div');
  el.className = 'eph-rings';
  el.innerHTML = '<i></i><i></i><i></i>';
  const alpha = (a) => (/^oklch\([^/]*\)$/.test(color) ? color.replace(')', ` / ${a})`) : `color-mix(in oklab, ${color} ${a * 100}%, transparent)`);
  [...el.children].forEach((i, k) => { i.style.inset = `${Math.round((size * 70 * k) / 520)}px`; i.style.boxShadow = `0 0 0 2px ${alpha(0.7)}, 0 0 18px ${alpha(0.35)}`; });
  const L = F.layer(el, { w: size, h: size, pad: 40, res, label: 'rings' });
  return {
    layer: L,
    /** The rings at world (x, y), `age` s into a pulse (one pulse lasts 1.1 s). */
    at(x, y, age, { z = 0, opacity = 1 } = {}) {
      const k = clamp(age / 1.1);
      return L.at(x, y, { z, s: 0.35 + 1.1 * E.out3(k), opacity: 0.55 * (1 - k) * opacity });
    },
  };
}
