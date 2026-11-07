// Headlines: the house film type, in screen space. Large, tight lines that rise in by line (from blur) and fall out
// on the clock; a word in `.lime` (or `.dream`) is the one that lands. Over busy footage a headline sits on a scrim, a
// soft dark falloff from the frame edge it is near, so it reads without a box.
//
//   const H = headlines(F);
//   H.add(['The whole team,', 'in the loop.'], { left: 110, top: 410, size: 84, t: 29, out: 32.6, lime: [1], scrim: 'left' });
//   sequence({ …, headlines: H.list })   // a headline leaves with its scene, carried by its swish
// (The page must load the fonts: Google Sans Flex for the lines, JetBrains Mono for the eyebrow.)
import { E, clamp } from '../engine/time.js';
import { W, H } from '../engine/camera.js';
import { lines, span } from './type.js';
import { css, ACCENT, DREAM } from './css.js';

const STYLE = `
.eph-hl { font-family: 'Google Sans Flex', 'Google Sans Text', sans-serif; font-weight: 560; letter-spacing: -0.035em; line-height: 0.98;
  white-space: nowrap; font-variation-settings: 'opsz' 144; color: var(--eph-ink, oklch(94% 0.012 130)); text-shadow: 0 2px 40px rgba(0, 0, 0, 0.45); }
.eph-hl > div { will-change: transform; }
.eph-hl .lime { color: ${ACCENT}; }
.eph-hl .dream { color: ${DREAM}; }
.eph-hl.center { text-align: center; }
.eph-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 17px; letter-spacing: 0.18em; text-transform: uppercase; color: ${ACCENT};
  white-space: nowrap; margin-bottom: 22px; }
.eph-scrim { position: absolute; inset: 0; }
.eph-scrim.left { background: linear-gradient(90deg, rgb(var(--eph-scrim, 4 7 5) / .86) 0%, rgb(var(--eph-scrim, 4 7 5) / .7) 30%, rgb(var(--eph-scrim, 4 7 5) / 0) 62%); }
.eph-scrim.top { background: linear-gradient(180deg, rgb(var(--eph-scrim, 4 7 5) / .88) 0%, rgb(var(--eph-scrim, 4 7 5) / .66) 24%, rgb(var(--eph-scrim, 4 7 5) / 0) 46%); }
`;
const div = (cls, html) => { const e = document.createElement('div'); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export function headlines(F) {
  css('headline', STYLE);
  const list = [], scrims = {};
  const scrimLayer = (side) => (scrims[side] ??= Object.assign(F.layer(div(`eph-scrim ${side}`), { w: W, h: H, pad: 0, res: 0.5, label: `scrim ${side}` }), { fullFrame: true }));
  /**
   * texts: one string per line (HTML allowed). left/top: where it sits (frame px; `center` centres it horizontally);
   * size: font px; t/out: in and out times; lime/dream: indices of accent lines; eyebrow: a small label above;
   * scrim: 'left' | 'top'.
   */
  function add(texts, { left = 120, top = 420, size = 120, t, out, lime = [], dream = [], eyebrow, center = false, scrim = null }) {
    const el = div(`eph-hl${center ? ' center' : ''}`);
    if (eyebrow) el.append(div('eph-eyebrow', eyebrow));
    texts.forEach((s, i) => { const d = div(lime.includes(i) ? 'lime' : dream.includes(i) ? 'dream' : '', s); d.style.fontSize = `${size}px`; el.append(d); });
    const L = F.layer(el, { pad: 110, res: 1, live: span(t, out, el.children.length), label: `hl ${texts[0]}` });
    lines(el, { t, out });
    const sc = scrim && scrimLayer(scrim);
    list.push({ t, out, node: () => L.at(center ? W / 2 : left + L.w / 2, top + L.h / 2 - (eyebrow ? 39 : 0), { screen: true }),
      scrim: sc && ((tt) => sc.at(W / 2, H / 2, { screen: true, opacity: E.mat(clamp((tt - (t - 0.15)) / 0.5)) * (1 - E.mat(clamp((tt - out) / 0.5))) })) });
  }
  return { add, list, scrim: scrimLayer };
}
