# Motion: stacks, operators and lanes

This chapter is for you and for your agent: the same rules hold whether you change motion in the studio or in the
film's code.

## A value is a stack

Anything that moves (a camera's yaw, a ball's height, a roughness) is a **stack of operators**, applied from the
bottom up. Each operator works on what the ones below it give:

| Operator | What it does | In code |
|---|---|---|
| **Base** | where it starts | `motion(62)`, a rig's start pose |
| **Rate** | grows steadily, so much a second (a drift, a spin) | `.rate(40)`, a rig's `drift` |
| **Moves** | eases to land on a value at a time (Aim), or by an amount (Add) | `.to(t, dur, v, ease)`, `.by(t, dur, dv, ease)` |
| **Keys** | values at times, eased into each | `.keys([[t, v], [t, v, ease]], { mode })` |
| **Wander** | a slow wobble (handheld, a bob) | `.wander(amp, { speed })`, a rig's `float` |
| **Hits** | a pulse on each note a part plays (a kick, an arpeggio), rising over its attack and falling away over its decay | `.hits(hits(TL, 'drums', { note: 36 }), { amount, attack, decay })` |

A value the code computes some other way (plain math in `scene(t)`) has no operators the studio can see: it shows as
one **Code** lane, and your lanes work on top of it.

### Modes: how an operator combines with what is below it

- **Add**: its values add to what is below. What is below shows through everywhere.
- **Aim**: it lands on its values at its times, whatever is below; what is below keeps moving in between and after.
  A `.to()` is a move in Aim mode: it is sized against the stack under it, so if the drift changes, it still lands.
- **Replace**: its own values over its keys' span (one key: everywhere), ignoring what is below; **influence** (0–1)
  blends between the two.
- **Multiply**: scales what is below (scale, opacity).

A rate and a wander always add. Switching a lane's mode keeps where it lands: each key's result, each move's arrival.

### Order

Order is a creative choice. Put a wobble *below* the moves and the camera lands exactly on its marks, shaking only
between them; put it *above* and it lands with the shake. A run of moves is one lane; each move in it is sized against
the ones before it.

## In code

```js
import { motion } from '../../engine/motion.js';

// the gold ball lifts off the floor on the cue, and bobs while it hangs there
const GOLD = {
  y: motion(62)
    .to(T.materials + 0.4, 0.7, -40)          // lifts off the floor
    .wander(8, { speed: 0.8 }),                // bobs while it hangs there
  ry: motion(0).rate(40, { from: T.materials }),
};
push(BALL.at(-575, GOLD.y, 0, { ry: GOLD.ry, ...GOLD_MATERIAL }));   // a motion placed as a value
```

- Place a motion **as a value** (`at()`, `many()` copies, material inputs). It is evaluated at the scene's moment, and
  the thing remembers it, so the studio shows its lanes. `GOLD.y.at(t)` gives the number if you need arithmetic, but a
  number has no lanes. `SPEED.integral(t)` gives what a motion adds up to from 0 to t (how far a speed has gone, how far
  a spin rate has turned), following the director's changes to it.
- A camera's `rig()` is a stack with a channel each for its kind's: x, y, z, zoom, yaw, pitch and roll (a target
  camera's tx, ty, tz in place of yaw and pitch; engine/lens.js). Its start is the base, its drift a rate, each
  `.to()`/`.by()`/swish a move, its float a wander on top. `.to()` and `.by()` name the channels they move; zoom is
  kept as a logarithm, so `.by(t, d, { zoom: 1.05 })` multiplies it.
- Write times against cues (`T.drop + 0.3`): a move retimed in the studio is stored as a shift, so it keeps following
  its cue when the cue moves.
- Sound moves the same way: a project's `sound.js` moves its instruments' parameters with motions
  (`part('bass').automate('Filter 1 Cutoff').to(…)`), shown and changed in the studio as these are
  (`.agents/skills/sound/SKILL.md`).
- And what is seen can move with the sound: `hits(TL, part, { note })` (engine/score.js) are a part's notes where the
  timeline plays them, for a `.hits()` pulse. Read the timeline with `heard()` so the notes sound.js writes are among
  them; the studio renders the frames again when the part's notes or clips change:

  ```js
  import { heard, hits } from '../../engine/score.js';
  const TL = await heard(await timeline(import.meta.url), import.meta.url);
  const swell = motion(1).hits(hits(TL, 'kick'), { amount: 0.35, attack: 0.008, decay: 0.18 });
  push(BALL.at(0, 0, 0, { s: swell }));
  ```
- A motion or rig is known by the line that makes it. Several made by one line (a loop: a camera for each shot) are
  numbered in the order they are made, and the director's changes to each stay on that one. Give those a `name` from
  what they show (`rig(t0, pose, { name: 'photo 10' })`, `motion(0, { name: … })`) so that the changes stay on their
  shot when shots are added or reordered.

## In the studio

Under the cues, the timeline's **Objects** lists the **film camera** and the **scene** (its light and lens), then each
thing the film's code places, as rows with a bar where each is in the scene. A row opens to its properties (the camera's
and the scene's by their twirl or a click, a thing's once it is selected), and a property opens to its lanes (top of the
stack first). The film's shots and its rendered frames are a strip under the ruler, which stays as the lanes scroll.

- **Reading a property.** Its row draws the property over the whole film as the frames have it; the playhead moves
  only its dot and readouts. The dashed line is what the code alone gives, so you see what your changes did. Its
  caption reads the stack bottom first ("62 › moves › wander › keys (yours)"). Each lane draws what it adds, and its
  readout is that amount at the playhead. Code operators are grey with their line (`film.js:57`, click it to see the
  code); yours are blue. Shading marks where the thing is not in the scene.
- **Parts.** What gives a property can change over the film: a camera for each shot, each its own rig. Each part has
  its stretch of the timeline (faint lines where one hands over to the next), and its operators sit in that stretch,
  in lanes shared with the other parts (each shot's Rate in one Rate lane). Click a lane in a stretch to choose that
  part's: the inspector edits it. A lane's head (its mode, on/off, reorder) changes it in every part it is in. A key
  or an operator added at the playhead goes into the part there. A key dragged beyond its part's stretch stays where it
  is, faint (with the nearest stretch of its motion): it still shapes the curve inside the stretch, and it can be
  selected and dragged like any other. Where the code changes the camera after its rig (a
  shake, a kick of zoom on the beat), a **Code** lane on top draws what it adds.
- **Vectors.** Position (X, Y, Z), Rotation and a camera's Target are one row each: its parts' values in their
  colours (X red, Y green, Z blue, as the viewer's axes), each part's curve faint on its own scale, and its keys: a
  solid ◆ where every part has a key then, a hollow one where some do. Open it for a row per part, each as any
  property. A property's row marks its keys on its curve.
- **Show.** *Animated* lists what moves (and what you changed); *Changed* only what you changed; *All* everything.
- **Height.** Drag a lane's bottom edge (in the left column); double-click it for tall, and again for back. *Lanes −
  Fit +* sizes them all; *Fit* fills the timeline. Tall lanes get value lines.

### Changing motion

- **Retime a move**: drag its bar. **When it lands**: drag its ◆. A key: drag it. Hold Alt to place freely.
- **Mode**: click the lane's mode chip (Add, Aim…).
- **Reorder**: drag a lane's handle (⋮⋮) above or below another of the same property.
- **Turn off**: the eye. The film renders without it.
- **Add an operator**: the + on a property row (keys, a move, a rate, a wander; on top). The ◆ on a property row keys
  it at the playhead (in your keys on top). Double-click a Keys lane to add a key there.
- **A vector's keys**: its ◆, or a double-click on its row, keys every part of it then (those with no key then).
  Drag one of its keys to retime every part's key then together; select it and Delete removes them all. Open it to
  key or move one part alone.
- **In the viewer**: with a thing selected and the pointer over the viewer, **G** moves it (at its own depth), **R**
  turns it, **S** scales it; or drag its gizmo, drawn in perspective: an arrow per axis (to move along it; one toward
  or away from you is short), a ring per axis (to turn about it; its far half faint), its centre (to move in the view's
  plane), its square (to scale). **X**, **Y**, **Z** keep to the world's axis; pressed twice, the thing's own (as it
  is turned); a third time, none. **R** without an axis turns about the world axis most along the view. A number typed
  is the amount; **Ctrl** snaps (10 px, 15°, 0.1); **Shift** is fine; a click or **Enter** sets it, **Esc** or a
  right click puts it back. As you go, the outline follows at once (the thing's corners, moved in 3D), what you are
  doing is drawn over it (the axis, the turn so far on its ring, the scale's reach from the centre), and the picture is
  drawn with the change. One gesture is one undo step.
- **Where a change in the viewer goes** (G, R, S, the gizmo, Lock to view) is the lane selected, at the playhead; the readout
  under the gesture says which:
  - a **Keys** lane: its key there, or a new key there;
  - a **Moves** lane: where its move landing there lands, or, between landings, a new move landing there, from where the
    move before it lands (into that lane if it is yours; else into a lane of yours just under it). The moves after it
    still land where they did;
  - a **Base**: everywhere;
  - a Rate, a Wander or Hits has no value to put there: it says so, and nothing changes.

  The thing's other properties the gesture moves go into the same lane of theirs (a camera move that names X and Yaw).
  One with no such lane, under a Moves lane: a move of its own over the same time, in a lane of yours over its base.
  With no lane selected, a change goes where the inspector's fields put it: into your keys at the playhead, or, with
  none, your value over the whole part. The value lands exactly where you put it, whatever the lanes around it do;
  one over it that holds it there (a Replace) is said.
- **The path and its points.** The selection's path through the film is drawn in the viewer, and the project camera's in
  the Director view: a ◆ at each of its keys, a dot where each of its moves lands, the lane selected's in the accent.
  Click a point to take the playhead there and select its key or move (and so its lane); drag it to move the thing
  there. **↑** and **↓** step the playhead to the point before or after (the lane selected's, or all of the thing's),
  as do ‹ › on the toolbar by the selection; with nothing selected they step through cues, clips and cuts. The
  Overlays panel turns the path off.
- **Lock to view** (by the Director tab, or on the camera's toolbar): the Director view is the project camera's and frames
  the film whole; orbiting, panning and dollying move the camera at the playhead, each gesture one change, into the
  lane selected by the rule above. Scrubbing and playing, the view follows the camera. F turns it off.
- **Every change shows at once**: an edit to motion (the gizmo, the inspector, a lane) is drawn in the viewer as soon
  as you make it, before it is saved; the film's pages take it in without loading again, and its frames render behind.
  Scale is one number (uniform), so it has no axes.
- **Inspector**: select a lane to edit its numbers (times, targets, eases, keys, influence), show its code, put it
  back to the code's, or remove yours. The object inspector's X/Y/Z, scale and material fields write the same lanes:
  a value set without ◆ holds everywhere; ◆ makes keys.

### Adding things by hand

The row at the foot of the Director view (a click each), **Shift+A**, or the **+** on *Objects* adds a shape (cube, sphere,
plane, cylinder, cone, torus) or a light (point, spot, sun). It lands where the viewer's camera looks, sized for the frame
there, lasts the film's length and comes selected: block something out, then ask your agent to build on it.

The **Layout** page (the window's foot, Shift+3) is laid out for this: the Director view large over a low timeline, drawn Fast
and without Pre-render so the picture keeps up. The Visual and Layout pages each keep their own view, look and Pre-render. On any page the Director view covers its
panel, the picture's overflow cut off; Preview always shows the film's whole frame.

- It is a thing like any other: G, R, S, the inspector, lanes and keys all work on it. S scales it along all its axes;
  S then X, Y or Z, or the small squares on its gizmo, along one of its own.
- **In and out**: its row's bar in *Objects* is solid. Drag the bar to move it in time, and its ends to trim it (or set
  **In** and **Out** in the inspector). A bar in stripes is one the code or the film decides, and stays where it is.
- **A light** has a type (point, spot, sun), colour, intensity and size, and a shadows switch. R turns a spot or a sun.
  Every light in the viewer can be turned and its shadows switched, the code's too.
- **The toolbar by the selection**, the row's right-click menu and the keys hold the rest: Focus (F), Duplicate (Shift+D),
  Colour, Material (Matte, Glossy, Metal, Glass, Glow), Hide (H), Delete (Del, only for what you added). Duplicating
  what the code places makes a linked copy: it moves as the original does, with your changes on top.

### Where your changes live

In the timeline's `overrides` (versioned with the rest of the timeline):

- On a **motion the code writes** (`{ "stack": "film.js:56:6", … }`): its operators changed (`ops`: `shift`, `dur`,
  `ease`, `mode`, `to`, `by`, `rate`, `amp`, `speed`, `keys`, `influence`), lanes reordered (`order`), turned off
  (`muted`), your lanes in it (`lanes`), per channel (a motion's is `value`; a rig's are x…roll, zoom as its log).
  Everything placed with that motion moves with them.
- On a **thing's plain value** (`{ "on": { "at", "nth", "key" | "like" }, "props": { "x": { "lanes": […] } } }`), or
  the **camera's** (`{ "on": { "camera": true }, … }`): your lanes over the code's value.
- On the **scene's own settings** (`{ "on": { "scene": true }, "props": … }`, the inspector's Scene with nothing
  selected): its view (`exposure`, `transform`), the lens (`bloom`, `vignette`), the light around (`intensity`,
  `zenith`, `horizon`, `nadir`) and the `backdrop`. The numbers take your lanes over the code's value (the code's
  `view`, `post` and `environment`); a colour is set in place of the code's, or keyed (`[{ "t", "v" }]`), and so is
  the transform (`"agx"`, `"neutral"`, `"standard"`). A backdrop with glows keeps them: its colour is set.
- On an **object, whole** (`{ "on": { "sites": ["lattice.js:81:17", "lattice.js:81:55"] }, "props": … }`): the same
  lanes on every copy that those lines place (an object is what the code defines with every line that places it, and
  all one line places: a loop's, a many()'s copies; the `objects` tool lists them). Each copy is changed as one would
  be, over its own value: moved by the same amount, turned and scaled about its own centre, its material's inputs and
  colour set. A copy's own change applies over its object's.

- To **hide** a thing: `"props": { "hidden": true }` on it, whole or on a copy. It is not in the film, but its row and lanes
  stay. A light's `"shadows"` (`true` | `false`) is set the same way.
- A **thing added by hand** is a clip on the timeline's `things` track, with a `thing` where other clips have `media`:
  `{ "id": "c7", "at": 2, "in": 0, "out": 8, "thing": { "type": "cube", "label": "Wall", "x": 0, "y": -100, "z": 0, "sx": 3,
  "sy": 1, "sz": 1, "baseColor": "#c8ccd2" } }`. A shape is 100 px across before its scale; a light's way is straight down
  before its turn (`rx`, `ry`, `rz`); `engine/things.js` is the reference. A linked copy has `"of"` (what it copies, as
  a change names a thing) and `x`, `y`, `z` as its offset. The changes on it name it `clip:<id>`, by which it never moves
  or orphans.

Lanes: `{ "id", "kind": "keys", "mode", "keys": [[t, v, ease?]], "influence"?, "static"? }`, `{ "kind": "moves",
"moves": [{ "t", "dur", "to" | "by", "ease"? }] }`, `{ "kind": "rate", "rate", "from" }`, `{ "kind": "wander", "amp",
"speed" }`. `engine/overrides.js` and `engine/motion.js` are the reference.

### When the code is edited: followed, or orphaned

A change names what it changes by where the code made it (`film.js:56:6`), so it also remembers the code on that line
(its `code`, written by the studio). Whenever the film's code changes, the studio checks each change (`nle/anchors.js`):

- the line still reads the same where it was: nothing happens;
- it reads the same somewhere else, and only there (lines added above it, the code moved, re-indented): the change
  **follows** it. It is never a guess: the same code, in one place;
- anything else (that line itself was edited, or reads the same in two places, so which one is unknowable): the change
  is **orphaned**. Its names become `orphan:film.js:56:6`, which nothing in the film is named, so it no longer applies,
  but it stays in the timeline with the code it was on. An orphan whose line comes back (the edit undone, the code moved
  back) is attached again.

Each of these is kept with the code change that made it, in its version of the project ("Your changes and the film's
code: …"). The timeline bar shows **N orphaned**:
each, with the code it was on, to remove (Ctrl+Z puts it back), or *Ask the agent to attach them again* (the menu names it as the settings do).

## For agents

- Write motion with `motion()` and rigs, placed as values, so the director can see and grab it. Plain math still
  works; it shows as one Code lane.
- Never drop the director's overrides. When asked to **fold them into the code**, change the code so the film looks
  the same without them, then remove them in one write that says so: a `shift` becomes the time expression
  (`T.drop + 0.3` → `T.drop + 0.5`), `to`/`by`/`ease`/`mode` the call's arguments, your lanes chained calls
  (`.keys([...], { mode })`, `.wander(…)`), an `order` the order of the calls, a muted lane a removed call (say so), a
  plain value's lanes a motion that replaces the plain value.
- A thing the director added by hand is their block-out: what they want, where and when, in rough. The `objects` tool
  lists it (`added: true`), and the message's selection names it (`clip:<id>`). Use it as direction and leave it in the
  timeline until you are asked to fold it. To **fold** it, place the real thing in the code as the film's other things are
  placed (read its position, turn, scale and material as they are now with `stacks`, your changes on it included), then
  remove the clip and the changes naming `clip:<id>` in one write that says so. Build what it stands for where the director
  asks: a cube they blocked in may be a building.
- Check a change with `POST …/api/stacks { t, sel }` (what a thing's properties come from at t), `…/api/lanes { sel,
  duration, fps, cuts }` (what gives each of them at every frame of the film) and `…/api/samples`.
- After editing film code, look at `status`: a change of the director's whose line you edited is **orphaned** (listed
  there, with the code it was on). If the code it changed still exists, attach it again: rename its `orphan:` names in
  the timeline to where that code now is (`orphan:film.js:56:6` → `film.js:58:6`, keeping any `#2`), or remove it if
  that code is gone. Say which you did. Changing a line the director has changed is a reason to tell them.
