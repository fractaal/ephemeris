# Known issues

Problems in the studio that are known and parked, to be fixed soon. Remove an entry when it is fixed.

## Editor: projects and agents

- **Three rows of tabs.** Projects, then the project's timelines, then the agent panel's own agent tabs. Too many tab
  bars stacked for one editor.
- **"Agent 1" tab with one agent.** The agent panel shows its row of agent tabs even when the project has a single
  agent; it could stay hidden until there is a second.
- **"End" beside the panel's close.** End stops the agent (its conversation is kept); the × next to it only hides the
  panel. Side by side, which does what is unclear. End may belong on each agent's tab, as a browser tab's close.
- **Conversations vs agents.** The panel header's Conversations (past transcripts, to continue) and the agent tabs
  (agents running now) do not say how they differ.

## Workspace

- **One place for Ephemeris.** A workspace (`~/Ephemeris`) reaches the studio through links (`engine/`, `elements/`,
  `assets/`, `nle/`, `docs/`, `./ephemeris`, the skills), and every command line run re-points them at its own copy:
  the app's (`~/.config/Ephemeris/studio/<sha>/`) or a checkout's. Re-pointed under a running studio, its dev server
  keeps the old copy for the files it has read and takes the new one for files changed since, so one film's page loads
  two engines: motions made with one read as 0 in the other's passes, and the timeline's changes reach only the copy
  that read the timeline (a launch film: a heart and the director's camera roll gone from the viewer). Ben's fix: no
  linking; Ephemeris lives in one place.
