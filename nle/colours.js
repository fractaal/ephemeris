// Each track a colour, as Live's, by its place among the timeline's tracks: its clips' heads filled with it, their bodies
// dark with its tint, their waves and notes in it (timeline.js, pianoroll.js, the mixer's strips).
export const TRACK_COLOURS = ['#a9b4ff', '#ff9aa5', '#ffad73', '#f4f29a', '#c4f07a', '#5eeedb', '#7fd0ff', '#c79cff', '#e07cf0', '#ff7eb6'];
/** `a` mixed toward `b` (both #rrggbb) by u (0: a, 1: b). */
export const mix = (a, b, u) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - u) + parseInt(b.slice(i, i + 2), 16) * u).toString(16).padStart(2, '0')).join('')}`;
const colours = new Map();
/** The colours of the track at index i: top (its clips' heads), body, wave, and each as selected. */
export function trackColour(i) {
  const top = TRACK_COLOURS[Math.max(0, i) % TRACK_COLOURS.length];
  if (!colours.has(top)) colours.set(top, { top, body: mix(top, '#0f0f0f', 0.78), wave: top, selTop: mix(top, '#ffffff', 0.4), selBody: mix(top, '#0f0f0f', 0.62), selWave: mix(top, '#ffffff', 0.4) });
  return colours.get(top);
}
