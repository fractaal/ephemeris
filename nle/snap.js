// Snap, as the timeline and the piano roll share it: by zoom (the finest lines at least 14 px apart), none, or a fixed
// length — a bar, or beats: coarse to fine, each named (a step is a quarter of a beat) and, where the name doesn't say,
// its length in beats. Alt places freely in both.
export const SNAPS = [['bar', 'Bar'], [1, 'Beat'], [1 / 2, '1/2 beat'], [1 / 3, '1/3 beat'], [1 / 4, 'Step', '1/4 beat'], [1 / 6, '1/6 beat'],
  [1 / 8, '1/2 step', '1/8 beat'], [1 / 12, '1/3 step', '1/12 beat'], [1 / 16, '1/4 step', '1/16 beat'], [1 / 24, '1/6 step', '1/24 beat']];
export const snapName = (per) => SNAPS.find(([v]) => v === per)?.[1] ?? `${per} beats`;
export const isSnap = (v) => SNAPS.some(([x]) => x === v);
const ZOOM_PERS = [1 / 8, 1 / 4, 1 / 2, 1, 'bar'];
/** Snapping by zoom: the finest of ZOOM_PERS whose lines are at least 14 px apart, in grid part p ({ beat, bar } in s), at
 *  pps pixels a second. */
export const zoomPer = (p, pps) => ZOOM_PERS.find((per) => (per === 'bar' ? p.bar : per * p.beat) * pps >= 14) ?? 'bar';
/** The Snap menu's fixed lengths, as menu items (checked: the one chosen), each choosing itself (set). */
export const snapItems = (chosen, set) => SNAPS.map(([v, name, beats]) => ({ label: name, hint: beats ?? '', checked: chosen === v, act: () => set(v) }));
