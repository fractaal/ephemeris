# The selection

The studio has one selection. Every panel shows it, every verb acts on it, and the agent receives it. A new thing that
can be selected joins this selection. It does not get a selection of its own.

## What can be selected

The selection is a set of items, and items of different kinds can be selected together. Each item has an owner, except
a thing and code lines.

| Item | What it names | Its owner |
|---|---|---|
| Thing | An object (one copy, or every copy), a light, a pass, the film camera, the scene | — |
| Property | One of a thing's properties, or a vector of them (Position, Rotation, Target) | Its thing |
| Lane | One operator lane of a property (Keys, Moves, Rate…) | Its property |
| Key | A key in a Keys lane, by its time | Its lane |
| Move | A move in a Moves lane | Its lane |
| Cue | A cue, by its id | — |
| Clip | A clip, by its id | — |
| Note | A note in a notes clip | Its clip |
| Code lines | A range of lines in one file of the film's code | — |

The last item clicked is the *active* item, and the inspector shows it. When several items are selected, the inspector
shows the active one and says how many others are selected.

The selection belongs to the editor, not to the film. It is not saved in the timeline, and undo does not change it.

## Owners

Selecting an item also selects its owners up to its thing. Selecting a key of the ball's Position selects the ball: the
viewer outlines it and shows its gizmo, its row in Objects is lit, and its lanes are open. Selecting a thing in the
viewer selects nothing below it.

A thing added by hand (a shape or a light, `docs/manual/motion.md`) and its clip are one item: selecting either selects
both, and its row in Objects is its clip.

Code lines and things are linked by the lines that place each thing. Selecting a thing marks its lines in the Code
panel. Selecting lines that place things also selects those things. Code lines are selected by selecting text in the
Code panel; a caret alone selects nothing, so clicking into the code to edit it leaves the selection as it is.

## Gestures

These are the same in every panel:

- A click replaces the selection with what was clicked.
- Shift-click or Ctrl-click adds an item, or takes it out if it is already selected.
- A Ctrl-drag draws a box, and selects the cues, clips, keys and moves it touches. With Shift, they are added to the
  selection.
- Esc steps out one level: code lines first, then from keys, moves or a lane to their thing, from one copy to the whole
  object, from a thing to nothing. Esc in a gesture under way (G, R, S, a drag) cancels that gesture instead.

Every panel draws the same selection: the viewer, the timeline (its rows, keys, moves, clips and cues), Objects, the
piano roll, the inspector and the Code panel.

## Verbs

G, R and S act on the selection in the panel under the pointer.

| Pointer over | G | R | S |
|---|---|---|---|
| The viewer | Moves the selected things | Rotates them | Scales them |
| The piano roll, focused | Moves the selected notes in time and pitch | Renders a draft | Stretches the selected notes' starts and lengths around the playhead |
| Anywhere else | Moves the selected keys, moves, clips and cues in time | Renders a draft | Stretches the timing of the selected keys, moves, clips and cues around the playhead. Splits the clip at the playhead when none are selected |

- In the viewer, G, R and S act on the things that can be moved: objects, lights, and the film camera in the director
  view. A pass has no place in the picture, so they do nothing to it. When keys are selected, the thing that owns them
  is the one transformed.
- The film camera, selected (its row or one of its lanes) in the director view, has the gizmo at its x, y, z: G moves
  it, R turns it about that point (an orbit camera swings round what it looks at; the others turn where they stand),
  and S zooms it. What it writes are offsets on its own motion, so the camera's moves go on under them. A target camera
  keeps its aim: only its roll turns.
- With several things selected (Shift- or Ctrl-click in the viewer or on their rows in Objects), the gizmo shows the
  one clicked last, and every other thing changes with it: moved and turned by as much, scaled as many times, each
  about its own centre. What a thing cannot do (a light turned) it leaves as it is. Each selected thing's lanes show
  under its row in Objects.
- G and S in time move cues, clips, keys and moves together, so a box over a stretch of the timeline retimes all of it.
  Stretching scales the times of keys, cues and moves (a move's start and length, a cue's start and length) around the
  playhead. A clip's start is scaled, and its length is kept.
- Every G, R and S works the same way. It follows the pointer until it is set and accepts a typed amount (in time:
  seconds for G, how many times as long for S). A click or Enter sets it, and Esc or a right-click puts everything
  back. The whole gesture is one undo step. In the viewer, Ctrl snaps and Shift is finer. In time, the earliest item
  snaps as a drag in the timeline does, and Alt places it freely.
- Dragging a selected clip, cue, key or move moves the rest of the selection in time with it. A click on one item of a
  larger selection, without dragging, selects that item alone.
- Delete removes the selected cues, clips, keys and moves, the selected lanes of yours, and the things added by hand with
  what was changed on them. The code's lanes and things stay: turn a lane off with its eye, hide a thing (H), or change
  the code.
- A transform in the viewer goes into the lane selected at the playhead: a key of a Keys lane, where a move of a Moves
  lane lands, a Base everywhere. With no lane selected, into your keys there. The rule, and what the other properties
  moved do, is in `docs/manual/motion.md` ("Where a change in the viewer goes"). The project camera locked to the
  Director view (Lock to view) takes its orbit, pan and dolly by the same rule.
- ↑ and ↓ step the playhead through the selected thing's points (its keys and where its moves land: the lane selected's,
  or all of them), drawn on its path in the viewer; a point clicked selects its key or move. With nothing selected, they
  step through cues, clips and cuts.
- F frames the selection in the Director view, going there from Preview, with the view's angle as it is; it never moves
  the project camera. With nothing selected, in the Director view, it frames the project camera.
- H hides the selection from the film, or shows it again: an object whole, or the copy selected. A thing hidden keeps its
  row and its lanes, and its row's eye shows it again. A picture has no row of its own, and is not hidden.
- Shift+D makes a copy of each selected thing beside it, and selects the copies. Of an added thing it is an independent
  copy. Of what the code places it is a linked copy: its motion stays the code's, with its own changes on top.
- Shift+A, the row at the foot of the Director view or the + on Objects adds a shape or a light where the viewer's camera looks, for the film's
  length, and selects it.

The toolbar by the selection in the viewer holds the same actions, each naming its key: Focus, Point the camera, Duplicate,
Colour, Material or a light's type, Hide, Delete, Select this copy or Every copy, and Ask. A click on an object of many copies
offers the copy clicked there. It hides while the film plays or a gesture goes on, and the Overlays panel turns it off.

The piano roll keeps its own keys while it has focus (Delete, quantize, legato…), and they act on the selected notes.
Without notes selected, its G and S are the timeline's.

## The agent

The agent panel sends the whole selection with a message. Each item is a chip that can be left out before sending, for
example "ball, every copy", "4 keys · ball › Position, 0.4–1.0 s", "film.js:120–134", "Bloom pass" or "2 cues". Each
chip carries what the agent needs to act on it: the thing's lines and copy, a lane's operator and its line, key times,
cue and clip ids, note times and pitches, a file and its line range.
