---
name: product-ui
description: Cookbook for putting a real product's UI into an Ephemeris film — capturing real states, rebuilding parts with the product's own CSS, wiring the product into the project, parity checks, and the pitfalls. Use when a film shows a product's interface.
---

# Putting a real product's UI in a film

How a project brings its product in is the project's concern, not Ephemeris's: Ephemeris only needs a page URL that
runs the film (the `url` in the project's timelines). This is the method that worked for a product film made in the
studio, and the pitfalls it hit. A project in the workspace made this way (one with `dev/` and `capture/` folders) is
the worked example: read its README, `dev/` and `capture/`.

## The principle

The UI on screen is the product's own: its markup, its CSS, its states. Never redraw it by hand, never show a feature
it does not have, never crop a component to fit a frame (show the whole page it lives on). The motion around it is
the film's.

## 1. Run the film inside the product

Clone the product locally into the project (`vendor/<product>`, gitignored; never edit the original checkout) and
serve the film from the product's own dev server, so the film page is same-origin with the product's CSS, fonts and
modules. The project's `dev/setup.sh` writes the film's pages and a Vite config into the clone (`mergeConfig` with the
product's own config; `server.fs.allow` the Ephemeris root so pages can import the engine and the project by path;
an `@app` alias to the product's `src`). `dev/serve.sh` serves it; the film's URL goes in its timelines' `url`.

## 2. Capture real states rather than rebuilding them

Script the product to the states the film needs and freeze its DOM:
- **A scripted session** (`capture/<product>-film`) drives the real app (mock backend) on a clock, so each state is
  reproducible: a thread working, a goal complete, a changes pane open, a call ringing.
- **Frozen screens**: the whole app at a moment, cloned to static HTML (`capture/freeze.js`): scroll positions kept as
  attributes, canvases kept as images, live form values written into the markup. Used for full pages and long takes.
- **Parts**: named components frozen with their ancestor chain (`capture/freeze-parts.js` → `parts/`), rebuilt by
  `parts.js` as standalone DOM whose wrappers carry the app's classes (so its selectors still match) but are
  neutralized for layout. Used for isolated components on a clean stage.

Freeze at times when the state is settled and nothing transient is open (a dialog that appears a frame later will be
in the snapshot).

## 3. Load every stylesheet

A part must get every stylesheet the app gives it, including the ones components import next to themselves
(`import.meta.glob('@app/components/**/*.css', { eager: true })`). Missing component CSS showed up as controls hanging
outside their box and a missing working glow.

## 4. Check parity before using a part

`capture/parity.mjs` screenshots the real app at each freeze time and renders every rebuilt part next to its crop of
the screenshot, so a mismatch is visible at a glance. Fix the cause (missing CSS, a viewport-height rule resolving
against the film page, an entrance animation resting offset) in `film.css` or the part, not by nudging pixels.

## 5. The pitfalls (each one happened)

- **One-shot entrance animations** are for live UI: switch them off on every part (`settle()`); keep infinite ambient
  loops (spinners, halos), which the engine pins to the film clock.
- **CSS transitions** fire when the film flips a state (a placeholder hiding) and would still be half-way when the
  frame is captured: turn them off on what the film flips.
- **JS-driven motion** (an oscillator, a state machine — a chat composer's working light) is frozen in a snapshot: run
  the product's own module on the film clock, stepped at a fixed rate from film start so any frame comes out the same.
- **WebGL canvases** (an animated flag) go blank when parallel workers press GPU memory: port the shader to an
  Ephemeris effect, draw it under or over the layer, and remove the canvas and its CSS fallback from the part.
- **Viewport units** resolve against the film page, not the product's viewport: pin heights (`100vh` → `100%`) on
  frozen screens.
- **Typing** goes into the real editor element with a film-drawn caret; a quoted chip, the placeholder and the send
  button's enabled state follow what is typed.
- **State changes** of a control (a radio, a connector's status) swap the control's markup between two frozen states
  at the moment of the click, from snapshots of the real app before and after.
- **Never imply features**: a call's message is the call's real message field; a reconnect flips to the real
  "connected" state of a neighbouring row.
