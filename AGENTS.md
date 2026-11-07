# Ephemeris

Ephemeris is a human-directed, agentic creative launchpad for making audiovisual work. A project can be a motion graphic,
a music-driven visual, a programmable effect, a product film, a title sequence, a 3D/VFX shot, or a piece that crosses
those forms.

The person is the director and the agent is a collaborator and technical executor inside the same editable project.
Film code, the timeline, media, music, assets, renders and history remain inspectable to both sides, while the source
and timeline stay changeable. This is not a prompt-and-reroll box: an agent may start a draft or implement a difficult
idea, but the work should stay open to direction, intervention and revision.

## Your job

Your job is to help make the work as good as it can be. Use all of your skill in code, shaders, design, animation, 3D,
VFX, music and sound. Reduce the technical distance between an idea and a working draft without taking the director's
place.

Ephemeris has two jobs:

1. It gives a person and an agent one place to direct, inspect and revise audiovisual work: the timeline, cues, code,
   media, music and rendered frames stay connected.
2. It provides an open rendering substrate: a camera, motion, cues, HTML layers, meshes, models, lights, effects, passes,
   surfaces, SDF objects, fog and fonts (`docs/manual/drawing.md`). These are useful primitives, not a closed visual
   language or a limit on what a film can become.

Use the primitives, change them, or write the renderer, shaders and effects the work needs. A whole film can be one
shader; a film can also bring in external assets or the result of a specialist tool where that is better. Ephemeris does
not decide how a piece should look, and it must not make the director's ambition smaller.

Make the work you would make with no framework at all, then make it directable. Do not stop at the first version that
works: look at the frames, listen to the sound, find what is weak, and make it better.

## Layout

- `engine/` (frames), `elements/` (building blocks: the pointer, headlines; `looks/`: SDF objects, fog),
  `tools/` (render, check, the editor's server, mix, the command line), `nle/` (the editor), `app/` (the studio as a
  desktop app), `assets/` (fonts, cursors), `templates/film/` (a new film: blank).
- `projects/<name>/` — the films. Each is a folder that holds everything the film is made of (timeline, film code,
  media, captures) and its history (`history/`): the studio keeps a version of its timelines and code together at each
  change (`./ephemeris history <name>`, the `history` and `restore` tools).
- Films can live in a workspace of their own (`~/Ephemeris`, say: `tools/workspace.mjs`), where `engine/`,
  `elements/`, `assets/`, `nle/`, `docs/`, the skills and `./ephemeris` are links into the studio.
- `./ephemeris new|serve|nle|stills|check|master|snapshot|compare|history <name>` — run it from this directory. Start
  your agent here, at the root (not inside a project), so that it sees the skills.
- One director per film: the editor is single-user, and the film is theirs.

## Skills

Read the skills that your task needs (`.agents/skills/`).

| Skill | Use it when |
|---|---|
| `engine` | You write film code. The reference for the engine, the looks, the tools and the editor. |
| `rendering-technique` | You change the studio's renderer (not a film): how light, shadows or reflections are computed, checked against papers and ground truth. |
| `new-film` | You start a film: the project, the music, the first draft. |
| `materialize` | The director changed the timeline and wants the next draft. |
| `review-draft` | You check a rendered draft before you show it to anyone. |
| `direction` | You read a director's notes, cues and comparisons. |
| `sound` | You add sound effects. The studio's tools that measure sound. |
| `musical-identity` | The director gives you a musical sketch to build the score on, or says the music lost its identity. |
| `product-ui` | You put a real product's interface into a film. |
| `editor-performance` | You change the editor's interface (`nle/`) where it updates as the timeline plays, or something in the editor is slow. |

`.agents/styles/` holds house styles. Each `STYLE.md` starts with the kind of film it fits. Read one when it fits the
film you are making: the director does not need to know it exists or name it. The director's own direction comes first.

## Rules

- Make the film directable. Write each thing that changes over time as a motion. Place each thing that a person would
  point at (a light, an object), so that the director can select it and change it. Give each param a name that a
  person can read.
- Check the rendered file before you say that a draft is ready. Say what you checked.
- Do not edit the director's cues. Write your own timeline changes with `write_timeline`, saying why.

If your task is to change the studio itself, read `docs/studio.md`.
