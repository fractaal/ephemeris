// Easing curves with no dependencies (the editor shares them): CSS's cubic-bezier, and the camera's glide.
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; const d = dx(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1;
    for (let i = 0; i < 20 && Math.abs(sx(t) - x) > 1e-6; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}

/** A camera move's ease: leaves gently, long settle (no kick at the start). */
export const glide = bezier(0.45, 0, 0.15, 1);

// Penner's power, expo, sine and back curves, written as GSAP writes them, so they give the same numbers its curves gave
// the films timed with them. Each is an ease in; its out is the in turned around, its in-out the in over each half.
export const easeOut = (easeIn) => (p) => 1 - easeIn(1 - p);
export const easeInOut = (easeIn) => (p) => (p < 0.5 ? easeIn(p * 2) / 2 : 1 - easeIn((1 - p) * 2) / 2);
/** p to the nth power (GSAP's power2 is n = 3, power3 n = 4). */
export const powerIn = (n) => (p) => Math.pow(p, n);
/** 2^10(p − 1), blended so that it starts at exactly 0 and ends at exactly 1. */
export const expoIn = (p) => Math.pow(2, 10 * (p - 1)) * p + p * p * p * p * p * p * (1 - p);
export const sineIn = (p) => (p === 1 ? 1 : -Math.cos(p * (Math.PI / 2)) + 1);
/** Overshoots its end by an amount that grows with `overshoot`, then settles back. */
export const backOut = (overshoot) => (p) => {
  const q = p - 1;
  return p ? q * q * ((overshoot + 1) * q + overshoot) + 1 : 0;
};
