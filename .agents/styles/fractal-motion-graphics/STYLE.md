# Fractal motion graphics: a house style

**Fits:** product films, launch films, UI and motion-graphics films.

A house style from Ben's direction on a product film (six versions) and the Ephemeris launch film. Read it when the film is one
of these, whether or not the director names it. Nothing in Ephemeris requires it, and the director's own direction
comes first. Read it as intent, not as rules to follow to the letter (see the `direction` skill). Each principle says
what it is, why, and where it came from.

The bar for every shot: **sexy, elegant, cinematic**, with flourishes and delight.

## 1. Product truth, embellished motion

The UI is what the product actually is: its real components, its real states, its own CSS. Never show a feature the
product does not have, and never imply one (a call carries a message because the app's calls have one). But how
things enter, move, react, select, ring, lift off and transition is ours, and should carry personality.
*Embellish the motion, not the product.* Light restyling is fine when the motif exists in the product (cropping a
banner's gutter so it reads as a pill alone).

Why: an early cut replayed the app literally and lost all its delight; another invented UI. Both were wrong.

## 2. The camera keeps moving

`./ephemeris check <film> --momentum` warns where a shot's camera rests or snaps back (the `track` tool shows a span's
numbers).

Every scene has its own rig: a **base move** that runs the whole scene (a slow drift down a growing list, a zoom out
of a reveal), chosen for the scene and subtle — *you feel it more than you see it* — with **expressive moves** layered
on top. No dead stops, no constant-speed crawls, no snap-backs. Scenes hand over with a **swish** (an operator's whip pan:
it leaves gently, gathers speed, passes the cut at its fastest with both sides streaking across it, and settles softly
into the next scene; about half a second each side) where a cut would feel arbitrary; hard cuts where they are the
rhythm (a montage on the beat). Graphics that belong to a scene leave with it, carried by its swish.

## 3. Continuity over cuts

Prefer one thing becoming the next over one thing replacing it: a long take through the real app instead of floating
isolated panes; the same composer component typed into, then working (not two components crossfading); the full-frame
flag cropping back down *exactly* onto the real banner, its chip shrinking into its exact place. A visible swap reads
as a seam, and seams read as cheap. When a handoff must happen, make it **seamless and exact**: same component, same
pixels, at the moment of the swap.

Isolated components ("expose a UI element by itself") and long takes are both tools; choose per sequence.

A cut can change the world without changing the shot: the camera and the subject make one move from first frame to
last, and each cut swaps only what is around them (GitHub's duck flight, recreated in `projects/duck`: its `take.js`
is the one move). The subject's place and pose and the camera's path carry straight across every cut. Build each world
around the take — a cylinder about the subject's path, with the camera and the subject at its centre — so it holds
whichever way the camera turns. Before recreating a reference, check across its cuts whether the camera and subject
continue.

## 4. Legibility, and personality needs time

Fast is fine; illegible is not. If you would have to pause to understand a beat, it is too fast. A pointer crossing
the screen takes **1.5 s or more** (`check` warns below that); short hops to a control right beside it and drags
(a selection) are meant to be quick. Character moves (a press, a pop, a ring) need the time to read.

## 5. Music first; cues conduct

The cut follows the music: the drop on the downbeat, montage hits on the beat, sections on phrases. The director's
cues in the NLE say roughly when sections happen and where hits land. They are **a conductor's wand, not control
points**: things lead in before a cue, overlap the next section, and follow through after it; only the beats that
matter (a click, a send, a drop) land exactly on one. Never make everything start and stop in lockstep on cues.

## 6. Centrepieces get room

When the director describes a moment in rich imagery ("whizzing", "a space probe", "gravitas", "the barest hint"),
it is a centrepiece: give it more time than the gap suggests, and let the next section overlap it rather than
squeezing it in. (The dream's giant pointer was first fitted into the window at 1.2 s; it became the film's high
point at 2.0 s.)

## 7. The pointer is a character

The pointer stands in for the viewer, so it is flattering — graceful, competent, a little magical — never a literal
cursor replay. It uses the real macOS pointers (arrow, I-beam over text, hand over controls), floats above the UI with
its shadow on it (parallax), and moves like **a paper airplane swerving around trees**: a smooth launch, a glide on
gentle curves, banking into turns, a decisive landing; a click is a clear nose-down press with a small rebound.
Playful but purposeful: never wobbly, never frantic. Show where it comes from (it can fly in from behind the camera).
It always draws above what it points at. (`elements/cursor.js` is this.) `./ephemeris check <film> --pacing` warns where it crosses
the screen in under 1.5 s.

## 8. Depth and physicality

Things feel real when they have mass and live in space: parallax, shadows falling on the UI, things lifting off,
scale contrast (a pointer passing huge past the lens), a slight lift of a layer while it has the stage. Opposing
motions through depth (the camera pulling out while something flies in) are what sell space.

## 9. Restraint: the shake is rare

The best details are sensed, not noticed. A camera shake, when something with mass passes the lens, legitimizes a
whole sequence — it implies an operator, a body, displaced air — *because* it is barely there (≈1.4 px for 0.7 s)
and has a visible cause. Never sprinkle it: one caused shake is an event; shakes everywhere are a style. Same for
stars that only resolve when you dive in, a comet that crosses once.

## 10. Rhymes and scale

Design moments to echo each other: the drop's flag fills the frame and crops into its banner; the dream's sky fills
the frame and closes onto its banner; the pointer's two entrances from behind the camera. A sequence that is one
breath of scale (inside a 40 px strip → the banner → the app → a wall of apps → crash into the logo, on one
continuous zoom-out base) reads as one gesture. Rhymes are what make a film feel designed rather than assembled.

## 11. Look

24 fps with a **45° shutter** is the house look: crisp, slightly staccato motion. Swishes open the shutter with their speed, to
180° at the cut, like a film camera's (at 45° a whip pan strobes; wider than 180° ghosts). Composite in sRGB like the browser; no grain unless deliberate. Type: large, tight,
confident headlines that rise in by line, with a soft scrim when they sit over busy UI; lime for the word that lands.

## Craft reference: a product film's high point (about 8 s)

A worked example of all of the above: a swish down into the night → the camera inside the app's night-sky banner at
8.5x (the banner's sky as an effect, sharp at any zoom; finer stars resolve only up close) → the frame closes onto the
banner → a giant pointer from behind the camera (1300 → 60 px above the UI over 2 s, through the centre of frame) with
the barest shake → it lands, types a message, sends
→ the composer lights up (the app's own working light) → one continuous zoom-out over the wall with two slow
look-arounds → the screens lift off → the crash into the end card. Every handoff overlaps the next.

## Starting a film in this style

`starter/` is this style's starting film: a title, a swish to a card that the pointer presses, an end title, with
placeholder cues. Make the project with `./ephemeris new <name>`, then copy `starter/`'s files over it (`film.js`,
`film.css`, `index.html`, `timelines/main.json`, keeping the timeline's `url`), and replace the placeholders.

### Music first

Find the track with the director and cut it in the NLE (drop audio onto a track; split, trim, fade; joins crossfade
on their own). The studio listens to each song placed (Beat This!, a beat-tracking model, ~10 s a song) and the grid
follows it: Detected, the default, is each song's tempo and bars from where its clip starts (its tempo map, from the
beats the model is sure of), so a second song in another tempo or metre has its own grid from its clip on. A director
sets a clip's tempo by hand (its Tempo in the inspector), or types a tempo for the whole grid. Ask `music` (MCP; `./ephemeris music <file>`) for a song's tempo, drops and parts (where it changes, A, B,
C…, a letter again where a part comes back, each with its intensity) in film time: the music decides the structure,
where it builds, drops, breathes, ends. Film code counts bars on the same grid with `tempo(TL.grid).b(bar, beat)`.

### Block out

The director places cues against the music (M drops one at the playhead, even while playing) with labels and notes.
If they want a starting point, seed placeholder cues for the story beats (`materialize` §1 on writing cues), at bar
lines, clearly placeholders. Agree the story in their words before building: what each section shows, and what the
film should feel like (`direction`).

### First assembly

Build in this order, verifying as you go (`engine`, and this style):
1. Scenes on their cues, each with its own camera rig (a base drift plus layered moves) and the handovers (swishes,
   hard cuts on the beat).
2. Content per scene: real components, type, the pointer.
3. Flourishes: entrances, selections, presses, the moments with personality.
4. Look: fps and shutter (house: 24 fps, 45°), lights, bloom on the hits.

Then `./ephemeris check`, stills at every scene, a draft through the NLE, and `review-draft` before showing it.

## The camera in this style

- The camera never stops. Each scene has its own `rig()`: a base move that runs the whole scene (`drift`, chosen
  for the scene and subtle — felt more than seen: a slow move down a growing list, a zoom out of a reveal), with
  expressive moves layered on top (`to()` arrives on a framing, `by()` is relative; `E.glide` by default, `E.apple`
  for a punch on a beat).
- Scene to scene: a `swish()` where a cut would feel arbitrary (`swishShape()`: a quartic launch over `dur`, the cut
  at full speed with both sides streaking across it, a softer settle over `durIn`; `sequence()` opens the shutter with
  its speed, to 180° at the cut). Keep the travel (`px`) short enough that each side is still in frame at the cut.
  Hard cuts where they are the rhythm (a montage).

## Sound in this style

These come from Ben's notes on the Ephemeris launch film's first sound pass; every one of them was a sound he took out
or moved. The `sound` skill has the tools that measure sounds.

### What gets a sound

- **Camera moves**: a pan, an orbit, a whip, a push. **Real objects doing things**: keys, clicks, typing, a press.
  **Things that fly**: a pointer whizzing past, a swoosh across the frame. A shot whose motion is a flowing shader or a
  readout can stay silent under the music: a data blip on a soft halftone, or a chime on an aurora, fights the picture.
- **Not every arrival.** Parts of a card landing do not each get a pop; a rapid run of pops reads as a toy. One sound
  for the gesture, or none.
- **Never busy.** A riser under a build that already builds, a whoosh on every cut, two sounds where one does: cut
  them. When in doubt, leave it out and let the music carry it.

### Which sound

- **Bassy over tinny.** Motion and impacts want low end (`sub`, `bassy`): you feel them in the chest. A whoosh or hit
  with no low end (`thin`) reads soft, flutey and cheap. Avoid soft, airy, "flooty" sounds for anything with weight.
- **Literal foley is the exception**: keys, clicks and typing are bright because the real thing is.
- **Fit the theme.** A confident, menacing, elegant film wants weight and restraint: deep swooshes, low impacts,
  rumbles. No cartoon pops, no chimes, no sparkles unless the picture is one.
- **Fast cutting wants swift, impactful sounds** (a montage on the beat: short, bassy, hard attack), not long soft whips.

### Shape and timing

- **A sound starts and ends the way its motion does.** A whip pan gets a swoosh that builds and peaks at the cut; a
  slow zoom out gets a slow swell that fades, never a build that ends in a thump (`stops-hard`); a pop gets a transient
  on the pop. Size it to the motion: a small move, a small sound.
- **Pans peak late**: the swoosh's peak lands as the new scene comes on screen, not at the moment the old one leaves.
- **Things that pass the camera lead**: you hear and feel the pointer whizz by before you see it, and a camera shake
  it causes comes before it too (sound, then shake, then picture).
- **Sync the transients.** When columns pop up one after another, each gets its transient on its own pop; a cluster of
  sounds near the moment reads as out of sync.
- Place by the sound's own shape: `at = moment − peakAt / speed` (or `onset` for a hit), from the measurer below.

## Reviewing a draft in this style

Run `./ephemeris check <film> --momentum --pacing` as well as the usual checks (`review-draft`).

- Is every moving element legible without pausing? Any pointer move frantic, or arriving from nowhere?
- Does the camera always move — felt more than seen — and do scenes hand over with swishes where a cut is arbitrary?
- Any visible swap at a handoff that should be seamless (same component, same pixels)?
- Is the product truthful: real components and states, no implied features, nothing cropped to fit?
- Do the hits land on the music; do other things lead in and follow through rather than start in lockstep?
- Is there restraint: rare, caused camera shake; details sensed rather than noticed?
