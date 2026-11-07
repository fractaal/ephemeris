---
name: review-draft
description: Check a film draft or master before anyone sees it — the gates, the actual rendered file, the changed moments. Use before telling a director a draft is ready, and when asked to review a film.
---

# Reviewing a draft

You cannot watch the film in motion, so review it as evidence: numbers, the actual rendered file, frames at the
moments that matter. A draft is ready only when the file the director will open has been checked.

## Gates

`./ephemeris check <name>`:
- **padding**: no layer's texture edge is visible (a clipped glow or shadow).
- **determinism**: the same frame comes out identical however it is reached.
- **cues** (warning): a cue the film reads that the timeline does not have (the film is using its fallback timing).
- **layers captured once** (warning): a layer whose DOM changes where one capture is reused (the change never shows,
  and which state does depends on render order: give it a live window over the change); and, in one line, the layers
  holding looping CSS animations there, which show still. Ambient loops in a product's UI are usually fine still; look
  for one that should visibly move.

A named style can ask for more (`--momentum`, `--pacing`: see its `STYLE.md`).

## When the studio changed

After any change to `engine/`, `elements/` or `tools/`, run `./ephemeris compare --all` (each project needs a
`./ephemeris snapshot` first, made on this machine): it lists every frame the change altered, with diff images. A
film should only change on purpose; when it does, look at the diffs, then take a new snapshot. Differences within
Chrome's raster noise (no pixel more than 2 levels off, at most 1000 pixels) are listed but not counted as changes:
Chrome draws some text and images a level differently depending on what a worker rendered before.

## The actual file

Sample what the director will watch: the NLE viewer's frames (`localhost:5340/p/<name>/<timeline>/preview/<frame>.jpg`, once it is up to
date), the draft file (`projects/<name>/renders/draft.mp4`), or the master:
- a frame every ~2.5 s: no black frames, no stretch where consecutive samples are identical (frozen), no missing layer;
- the moments that changed since the last draft, at full size (the viewer marks them: `preview.frames` digit 3);
- `ffprobe` for frame rate, frame count, duration and an audio stream on masters.

A broken draft once reached the director because single-worker stills looked fine while the 8-worker draft ran out
of GPU memory; another showed flat placeholder banners because WebGL contexts were lost in parallel. Check the file.

## Masters

`./ephemeris master <name>` renders with the timeline's fps and shutter, full motion blur and the timeline's music
mix. It writes three files in `projects/<name>/renders/`:

- `<name>-<stamp>.mp4`: the master, at full quality. It is large (film grain can make it 100 Mbit/s or more).
- `<name>-<stamp>-share.mp4`: a copy to send, at 10 Mbit/s (75 MB a minute), encoded so that grain stays grain.
- `<name>-<stamp>.json`: what was rendered, and with which Ephemeris. It is written last. When it is there, the master
  and the share copy are both done. The command's last line says the same, with each file's size.

Each video appears only when it is complete. Check the share copy's size against where it is going.
