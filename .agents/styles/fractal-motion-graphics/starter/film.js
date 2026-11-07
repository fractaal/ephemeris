// The starting film: a title, a swish to a card that the pointer presses, an end title. It shows the house style's
// moving parts — a rig per scene whose base move never stops, a swish between scenes, headlines, the pointer, scene
// times from the timeline's cues — and is meant to be replaced by the film.
const TL = await timeline(import.meta.url);   // the timeline its page names (main by default)
import './film.css';
import { createFilm, timeline } from '../../engine/runtime.js';
import { cam, rig, swish, frame } from '../../engine/camera.js';
import { E, clamp } from '../../engine/time.js';
import { cursor } from '../../elements/cursor.js';
import { headlines } from '../../elements/headline.js';
import { sequence, BACKDROP } from '../../elements/sequence.js';
import { cues } from '../../elements/cues.js';

const F = createFilm();
// scene times come from the director's cues, by name (moving a cue in the NLE moves its moment); the film lasts as long
// as its music, or until the "out" cue
const C = cues(F, TL);
const T = { title: C.at('title', 0), card: C.at('card', 3), end: C.at('end', 8), out: C.at('out', 11) };
const music = Math.max(0, ...TL.tracks.filter((tr) => tr.kind !== 'visual').flatMap((tr) => tr.clips.map((c) => c.at + c.out - c.in)));   // (the tracks heard)
const DURATION = music || T.out;

const H = headlines(F);
H.add(['Every film', 'starts <span class="lime">here.</span>'], { size: 120, t: T.title + 0.3, out: T.card - 0.45 });
H.add(['Make it <span class="lime">yours.</span>'], { top: 470, size: 120, t: T.end + 0.25, out: T.out - 0.6, center: true });

// the card: any DOM, captured as a layer (res: the largest on-screen scale it is seen at; live while its DOM changes)
const el = document.createElement('div');
el.className = 'card';
el.innerHTML = '<h2>A real component</h2><p>Authored in HTML and CSS, moved by the camera,<br>pressed by the pointer.</p><button>Ship it</button>';
const PRESS = T.card + 2.4;
const CARD = F.layer(el, { w: 560, h: 260, pad: 120, res: 2.2, live: [PRESS - 0.05, PRESS + 0.05] });
const button = el.querySelector('button');
const ptr = cursor(F, { z: 2 });

const CAM = {};
const SWISH = { [T.card]: { px: [1100, 0], dur: 0.5 } };
function ready() {
  const b = CARD.world(button, 0, 0), card = { x: -CARD.w / 2, y: -CARD.h / 2, w: CARD.w, h: CARD.h };
  // the pointer glides in (1.5 s or more across the screen) and presses the button
  ptr.from([b.x + 520, b.y + 330]).move(T.card + 0.6, [b.x + b.w * 0.5, b.y + b.h * 0.55], { dur: 1.6, shape: 'hand' }).click(PRESS)
    .move(PRESS + 0.3, [b.x + 380, b.y + 240], { dur: 1.5 });
  // each scene has its own rig: a base move that never stops, expressive moves layered on top
  CAM.title = rig(T.title, cam({ zoom: 1 }), { drift: { x: 6, zoom: 0.01 } });
  CAM.card = rig(T.card, { ...frame(card, { width: 1100 }), yaw: -8, pitch: 3 }, { drift: { zoom: 0.025, yaw: 0.6 }, float: 2 })
    .to(PRESS - 0.6, 0.9, { ...frame(card, { width: 1300 }), yaw: -2, pitch: 1 });
  CAM.end = rig(T.end, cam({ zoom: 1 }), { drift: { zoom: -0.02 } });
  swish(CAM.title, CAM.card, T.card, SWISH[T.card]);
}
function update(t) { button.classList.toggle('on', t >= PRESS); }

const lime = (k) => [0.1 * k, 0.16 * k, 0.03 * k];
const SEQ = sequence({
  cams: CAM, swishes: SWISH, headlines: H.list,
  scenes: [
    { t0: T.title, cam: 'title', environment: { backdrop: BACKDROP([0.02, 0.026, 0.02], [{ x: 1350, y: 300, r: 950, color: lime(0.6) }]) }, draw() {} },
    { t0: T.card, cam: 'card', environment: { backdrop: BACKDROP([0.02, 0.026, 0.02], [{ x: 600, y: 300, r: 900, color: lime(0.7) }]) }, draw(t, push) {
      const p = E.apple(clamp((t - T.card) / 0.6));
      push(CARD.at(0, 30 * (1 - p), { opacity: p }), ...ptr.nodes(t));
    } },
    { t0: T.end, cam: 'end', environment: { backdrop: BACKDROP([0.012, 0.015, 0.012]) }, draw() {} },
  ],
});
F.run({ duration: DURATION, cuts: SEQ.cuts, ready, update, scene: SEQ.at });
