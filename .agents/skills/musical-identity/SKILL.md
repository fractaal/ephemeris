---
name: musical-identity
description: How to build a whole score from a director's musical sketch (a loop, phrase or motif they wrote or chose) so every section carries its identity — "the je ne sais quoi of that small piece stretched out to the entire film" — without looping it verbatim or drifting away from it. Use when a director gives you a sketch or motif to build on, or says the music has lost its identity, its coherence or its story.
---

# Musical identity

*Draft: not reviewed by Ben.*

A director who hands you a sketch is asking for neither extreme. Not a copy ("obviously I don't mean copy-paste this
thing"), and not something new in its spirit ("not 'just do whatever'"). They want what makes the sketch recognisable
kept everywhere, and everything else free to change: a theme and its variations. Every variation should make a
listener think "that's the same tune". A score built this way tells one story; a score of well-made sections with
their own chords sounds like a medley.

## 1. Name the identity before you write

Read the sketch's notes (`notes`) and write down, a sentence each, the traits a listener knows it by. Usually:

- **The bass and its proportions:** its notes, its contour, and how long each chord lasts against the others (6, 2, 4
  and 4 beats, say). The proportions are as much the identity as the pitches.
- **The figure's shape:** the direction of its line, its rhythm, its characteristic interval (a semitone rubbing
  against the chord, a leap).
- **Its harmonic colour:** the mode, an added note, an ambiguity it never resolves (a minor key and its relative
  major).
- **Its pulse and its sound:** the rate (steady eighths), the instrument, how it rings.

Tell the director what you think the identity is, and ask whether that is it. Getting this wrong costs a round.

## 2. What holds

- **The cycle's timing.** Keep the progression's rhythm, and the phase of its cycle, in every section, so the chords
  change where the listener expects them ("there's a ratio and an expected time for the instruments to come in").
  Never compress the cycle to drive a build or reach an ending: that mangles the identity even when every chord is
  right.
- **Proportions under augmentation.** You may stretch the whole progression (half speed across a long section) if
  every part over it stretches with it. A stretched section that lasts a whole number of cycles leaves the cycle's
  phase where it was, and the original speed coming back afterwards reads as a lift.
- **What the sketch leaves open.** Do not resolve it with a cadence the sketch never had (a forced major ending).
  "Just let things lie."
- **The bass, heard.** One low voice at a time, and it plays the sketch's bass line. Do not drop it out where the
  picture is strongest.

## 3. What can change

Anything that keeps the traits in section 1. This is judgement, not a rule set ("not hard constraints, that can
stifle your creativity"): the test is whether it sounds good and stays recognisable, not whether every note is in the
chord.

- **Voicing and arpeggio.** Re-voice the figure on each chord's notes, keeping its shape (a falling figure becomes a
  falling arpeggio of each chord), or let it climb through the chord as a section builds. New pitches are welcome when
  the shape and colour stay.
- **Density and register.** Eighths to sixteenths into a peak; an octave higher; the figure on another grid
  (3+3+2).
- **Orchestration.** Pass the figure between instruments; double it on a new colour; stretch the figure's notes over
  the bass's notes as a slow melody (its four notes over the bass's four, each changing with the bass).
- **A response.** A slight change to the progression as call and response, at a few strong moments: the bass climbing
  a step into the next cycle instead of falling, with the harmony above unchanged.
- **Arrangement.** Which parts play, how loud, where it breathes.
- **A sound for a visual event.** Give it a piece of the identity (a beat of the figure for each beat of the
  animation), not a melody of its own.

## 4. What breaks it

Each of these happened on one film:

- Slow pads, choirs or drones changing chord every bar: their attack and release smear into mud. Hold them on notes
  all the chords share.
- A drone, low strings or a sub layer under the bass: the bass stops being heard as the director's.
- An opening of clusters, or a chord from outside the sketch: "I can't hear a coherent chord".
- Gestures foreign to the figure (a glissando, a two-note flutter) and melodies invented for one event.
- The bass taken out for a breakdown at the film's biggest picture: "no bass and no oomph".
- The bass ending a peak a few bars early: "a weird hollowness".
- The cycle sped up toward the end, into a cadence the sketch never had.
- Another part on the figure's instrument and pitch but off its rhythm: it blurs the figure.

`sound/MUSIC.md` warns against constant arpeggios. When the director's sketch is an ostinato or an arpeggio, the
sketch wins: keep it, and vary it as above.

## 5. Build it, check it, show it

- Generate the parts from the sketch with a script: lay out the cycle across the film (its sections, any stretched
  ones, any responses) and derive every part from it, so no part can drift off the cycle. Keep the script in the
  project's scratch space and rerun it after each round.
- Line the cycle up with the picture: put the big moments (a drop, a reveal, a title) on the cycle's strong points.
  Moving your own cues is fine; moving the music off its cycle is not.
- Read the parts back (`notes`): in every section the chord changes fall at the same places in the cycle.
- Measure each section with `levels` (with bands): the bass clearly present against the figure in the quiet parts,
  nothing but bass and kick loudest under 125 Hz, the figure's instrument leading the mix.
- Tell the director what you kept, what you varied and why, and any liberty you took (a response, a stretched
  section), with how to revert it. Ask them to judge named moments ("does the bass climb into the Rose work?").
