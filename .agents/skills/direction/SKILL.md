---
name: direction
description: How to read a director's notes, cues and analogies in Ephemeris (Ben's vocabulary — "Bible verse, not Starfleet mandate", "conductor's wand", "paper airplane"…). Use whenever you read notes in the NLE, a message with creative direction, or feedback on a draft.
---

# Reading direction

Directors here describe how a moment should *feel*, usually in an image, rather than what to change. Your job is to
unpack each image into concrete motion properties, decide what the note governs, and build that — then show it.

## How to read any note

- **Intent governs, not the letter.** "More a Bible verse than a Starfleet mandate"; "within reason". A note is never
  an excuse for malicious compliance, and never a rule that should strip out delight a director liked before. If a
  note seems to forbid something that made an earlier version good, keep the delight or ask.
- **Cues are a conductor's wand, not control points.** In the NLE a cue marks roughly when a section happens, or where
  a hit lands. Lead in before it, overlap after it, land exactly on it only where that matters (a click, a send, a
  drop). Range cues mark spans ("the glide to the send button should last this long").
- **"No? yes?", "kinda, no?", "you get it? or nah"** are proposals inviting your judgment: refine or push back.
- **"I think I muted you when I said …"** means you over-corrected an earlier note. Fix how you read the director,
  not just the shot.
- **"A lot of grays and questions of judgement and taste"**: the director expects your taste, not only execution.
- Precise craft words ("45 degrees", "shutter", "24 fps", "swish") mean exactly that. Vibe words ("goofy", "sexy")
  mean: use your taste to fix it.

## The NLE as the conversation

Notes live on the timeline where they apply (a timeline's cues: `label`, `note`); the project's history (the `history`
tool, `./ephemeris history <name>`) shows what the director moved and in what order (dragging a cue four times is
searching for a feel, not stating a number). Labels like "issue" vs "suggestion" separate defects from ideas. Never
overwrite a director's cues; add or change your own cues only when asked, and write them with `write_timeline`, saying
why (see `materialize`).

## Vocabulary

**Register**
- "Sexy, elegant, cinematic"; "flourishes", "delight", "personality" — the bar.
- "Apple-like / Vox-like" — polished, playful, objects with character, flattering to the user.
- "Worldbuilding" — staged, slightly magical moments that make the product world feel alive.

**Motion images**
- "You feel it more than you see it" — the camera's base drift: always moving, subtle.
- "Saturnian" — slow, orbital, unhurried, graceful.
- "A toy car in stop motion" — character with weight: squash and stretch, anticipation, stops, an obvious tilted click.
- "A paper airplane swerving around trees" — launches smoothly, glides with momentum, banks into turns, lands
  decisively; not wobbly, no tumbling. (Ben moved from the toy car to this: about 60% of the squash and stretch, much
  less arcing and rotation.)
- "Passing by a space probe" — slow, heavy, giant scale close to the lens, gravitas, the barest camera shake.
- "Personality needs time" — give character moves the duration to read.

**Problem words**
- "Frantic" — too fast to read, or it comes from nowhere.
- "Wobbly" (vs "purposeful", "decisive") — springy overshoots, tumbling, too much rotation.
- "Janky" / "nearly no easing" — constant-speed crawls, dead stops, abrupt whips.
- "Goofy" — hand-made or cartoonish assets that undercut polish: use the real thing.
- "Seamless and exact" — no visible swap at a handoff; the same component, the same pixels.
- "Lights up" (a composer) — the product's own working-light flare.

**Structure**
- "Expose a UI element by itself" — an isolated real component on a clean stage.
- "One long take / an elaborate show of the UI" — a continuous camera through the real, full app.

## Translating an image (example)

"Make the pointer a paper airplane swerving around trees, playful but decisive, not wobbly":
a launch-and-glide ease with a hair of overshoot (no wind-up); banking (roll) in proportion to how fast its heading
turns; little steering of the nose; no tumbling from speed; gentle arcs; squash and stretch held back; clicks stay a
clear nose-down press with a short rebound. Each word of the image became a parameter.

## When you show work

Say what changed in the director's terms, what you decided and why (especially where you used judgment or departed
from a note's letter), what you verified and how, and what is still open. Ask when a decision changes what the
director agreed to; otherwise decide and say so.
