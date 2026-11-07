// Elements carry their own styles: each is injected once, the first time an element that needs it is made.
const done = new Set();
export function css(id, text) {
  if (done.has(id)) return;
  done.add(id);
  const s = document.createElement('style');
  s.dataset.ephemeris = id;
  s.textContent = text;
  document.head.append(s);
}
// the house accent (lime) and the dream accent (indigo)
export const LIME = 'oklch(88% 0.17 113)', DREAM = 'oklch(78% 0.07 268)';
// A film can theme the house elements with CSS variables on :root (its own palette); unset, they keep the house colours.
//   --eph-accent (the word that lands, the caret, eyebrows), --eph-ink (headline text), --eph-scrim (a scrim's r g b)
export const ACCENT = `var(--eph-accent, ${LIME})`;
