// Typing into real UI: natural keystroke timing, a caret drawn by the film (there is no live input), and text typed
// into a real editor element with the editor's own placeholder and send button following along.
import { rng } from '../engine/time.js';
import { css, ACCENT } from './css.js';

/** A time for each character of `text` between t0 and t1 (a little uneven, a beat longer on spaces). */
export function typing(text, t0, t1, seed = 11) {
  const r = rng(seed), w = [...text].map((c) => 0.7 + r() * 0.6 + (c === ' ' ? 0.35 : 0));
  const total = w.reduce((a, x) => a + x, 0);
  let acc = 0;
  return w.map((x) => t0 + (t1 - t0) * ((acc += x) / total));
}
/** How many characters are typed at t. */
export const typedCount = (times, t) => { let n = 0; while (n < times.length && times[n] <= t) n++; return n; };
/** The caret: on while typing, then blinking at ~1.06 s (a typical text field's period). */
export const caretOn = (t, t0, t1) => t >= t0 && (t <= t1 + 0.05 || (t - t1) % 1.06 < 0.53);
/** A caret element (inline, the height of the line). */
export function caret() {
  css('caret', `.eph-caret { display: inline-block; width: 2px; height: 1.15em; margin-left: 1px; vertical-align: text-bottom; background: ${ACCENT}; border-radius: 1px; }`);
  const e = document.createElement('span');
  e.className = 'eph-caret';
  return e;
}
/**
 * Types `text` into a real editor element at time t (call from the film's update(t)): its other content is cleared
 * except `keep` (a chip), a caret shows while typing, the placeholder shows only while it is empty and not being typed
 * into, and `send` is enabled when there is something to send. At `until` (sent) it empties.
 */
export function typeInto(t, editor, text, times, { keep, t0, t1, until = Infinity, placeholder, send, hasChip = false }) {
  if (!editor) return;
  for (const node of [...editor.childNodes]) if (node !== keep) node.remove();
  const n = t < until ? typedCount(times, t) : 0;
  if (n) editor.append(document.createTextNode(text.slice(0, n)));
  if (t < until && t >= t0 - 0.05 && caretOn(t, t0, t1)) editor.append(caret());
  if (placeholder) placeholder.dataset.visible = String(!hasChip && n === 0 && !(t >= t0 - 0.05 && t < until));
  if (send) send.disabled = !(hasChip || n);
}
