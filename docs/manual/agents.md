# Working with an agent

Ephemeris is designed for a person and an agent to work on the same editable audiovisual project. The agent is not a
one-shot generator at the edge of the workflow: it can inspect the current frame, timeline and selection, prototype an
effect, edit code, measure the music, and make a change that the person can direct again. The project remains the
source of truth, with its film code, timeline, media and history visible to both sides.

There is one way in for every agent: the **Ephemeris MCP server** (`./ephemeris mcp`, over stdio). The panel in the
studio uses it, whichever harness runs it, and so can Claude Code, Codex, Pi, or any client that speaks MCP. The tools
are the same everywhere.

## Agents in the studio

Press **L** (or the agent's name in the top bar) for the panel, a column beside the studio. The agent is called
*Ephemerides*, *Eph* for short, unless you name it otherwise (**File › Settings…**, Ctrl+,): the panel, its button and the
agent itself use the name.

**New agent** adds an independent conversation to the current project. Its tabs let you switch between agents without
stopping them. Each has its own model, effort, permissions, messages and approvals. **Stop** interrupts only the agent
shown; **End** closes that agent and keeps its conversation.

Project tabs sit below the top bar; **+**, the project menu or Ctrl+O opens another project. Agents keep working when you
switch projects or close an editor tab, and the tabs and project picker show agents working or waiting for approval.
Returning reconnects to their current conversations. You can also keep editors for different projects open in separate
browser tabs. Timeline edits save before switching; unsent messages and manual code drafts stay in that browser tab.
The studio must stay running: quitting the app stops its agents; **Conversations** lets you resume their saved transcripts.

Agents share the project's **live files** with you and each other, not isolated drafts. Timeline tools and the Code
panel reject writes based on stale contents. Agents' ordinary file tools are not a merge system: give overlapping tasks
clear direction, and use History if an edit needs undoing.

- **What it gets with each message**: what the studio shows as you send it, as chips above the box: what you selected
  in the viewer (an object whole, or one copy of it), the property, lane or key selected in the timeline, the cues and
  clips you selected, the notes selected in the piano roll, the playhead, and the frame on screen. Click
  a chip's × to leave it out. "This", "here" and "now" in your message mean those.
- **Your own images**: paste them, drop them on the box, or attach them (the paperclip).
- **While it works**: your next message can reach it *after this step* (it reads it as soon as its current tool calls
  finish), *when done* (held until it has finished), or *now* (work that can wait moves to the background, or it
  stops, and it reads your message). *Stop* (or Esc in the box) stops it.
- **What it does**: each tool it uses is one line. The frames it looked at are thumbnails: click one to go there. A
  thing it picked is a link that selects it. `film.js:57` in its replies opens that line in the Code panel.
- **Asking**: it reads, looks and edits the film's files and timeline without asking (every change to them is kept as a
  version of the project: the History has each one, and Restore brings one back). Before a command that needs permission, it asks: *Allow*, *Always allow* (for this conversation), or *Don't*. A question it asks you with
  choices of its own shows them as buttons.
  - *Auto (no prompts)*, in Pi (the default): Ephemeris judges commands and allows or denies them without asking you.
    A denied command returns a security denial to the agent. Failed evaluations retry up to ten times, then return:
    “The security system failed to evaluate this tool call. This is not indicative of a block. You may retry shortly.”
    The command does not run; the agent can distinguish an unavailable evaluator from an actual denial.
  - *Ask first*: Pi asks before every command. Antigravity asks for commands through its own permission system.
  - *Bypass permissions (DANGER)*, in Pi: commands run without security evaluation or approval prompts, including
    commands outside the project. History is not a sandbox and cannot undo every command.

  Switching Pi from *Ask first* to either unattended mode also re-evaluates waiting tool approvals. Actual questions
  about your direction still need your answer; permission modes do not answer them for you.
- **From the studio**: *Ask* (with its name) in the inspector (a thing, a lane) opens the panel with that in its chips.
  *Fold into code…* (in the timeline bar, when the timeline has your changes or things you added by hand) asks it to write them into the code.
- **It shows you things**: it can move the playhead, select a thing or the camera, open a property's lanes, or show a
  line of code, with a short note at the top of the studio.
- *Conversations* lists this project's past conversations, across harnesses. Opening one already running selects its
  agent; opening a past one adds an agent to continue it without stopping the others.

### What runs it

New agents use the default harness chosen in Settings. Each agent can use a different harness by picking one of its
models in the panel's model menu
(grouped by harness; picking another harness's model ends the conversation shown, and your next message starts one
there, without affecting other agents). Each runs on your own machine, signed in as you sign it in; Ephemeris has no login of its own. Model, effort and permissions are independent for each live agent; changes also become this machine's defaults for new agents.

| Harness | What it is | Signing in | Auto | Notes |
|---|---|---|---|---|
| **Pi** | Pi's SDK, in the studio's process: Codex through ChatGPT, Anthropic, Copilot, Gemini, API keys, local servers | `pi` (or `./ephemeris pi`), then `/login` (`/login openai` is Sign in with ChatGPT) | Ephemeris uses the session's model to allow or deny commands, never falling back to human approval | its sign-ins and models are Pi's (`~/.pi/agent`); it reads the workspace's instructions and skills, not your own Pi extensions, skills or system prompt; `./ephemeris pi --resume` in the workspace lists its conversations |
| **Antigravity** (highly experimental) | Google's Antigravity agent for ACP apps (`antigravity-acp`), installed from the settings (about a gigabyte, into `~/.cache/ephemeris/agents`) | the settings: Google, Gemini Enterprise, a Gemini API key (`GEMINI_API_KEY`), or the Enterprise Agent Platform | none of its own: it asks before each command | a message sent while it works waits for the end of its turn; of a tool's result it shows only a line of its own (no frame thumbnails); deleting a conversation takes it off the list (Antigravity keeps its transcript); a Google account without a Google AI plan has a weekly quota |

On a personal Google account, Google supports Antigravity in ACP editors (Zed, JetBrains) but not in third-party apps or
agents that route prompts into it, and has not said which of those Ephemeris counts as. A Gemini API key or an
Enterprise sign-in is plainly allowed.

## Other clients: connect to the MCP server

Keep the studio running (`./ephemeris`). Each MCP connection has its own selected timeline. Pass `--project <name>`
and optionally `--timeline <id>` to choose it at launch. Otherwise the first tool request binds to the editor last
opened. Subsequent editor navigation does not change the connection's target; `status` names it, and `open` selects
another timeline for that connection without moving any editor or other agent.

A panel agent's studio tools stay within its assigned project. Its `open` tool can select another timeline in that
project; message context still names the timeline you were viewing when you sent it. This scopes the studio tools,
not the harness's filesystem access.

```sh
# Claude Code
claude mcp add ephemeris -- <repo>/ephemeris mcp

# Codex: ~/.codex/config.toml
[mcp_servers.ephemeris]
command = "<repo>/ephemeris"
args = ["mcp"]
```

`--studio <url>` (or `EPHEMERIS_STUDIO`) points it at a studio on another port or machine.

| Tool | What it does |
|---|---|
| `status` | this agent's selected project and timeline: the film, its frames, any error, the director's changes your code edits orphaned. Start here, and look again after editing film code |
| `projects`, `open` | list projects; select a timeline for this agent without moving the director or other agents |
| `frames` | the film at up to 8 times, as images (rendered first if they are not yet) |
| `view`, `camera` | the scene from a camera of your own; the film camera's pose |
| `pick`, `locate` | what is at a point at t (and the line of code that placed it); where it is then |
| `objects` | the film's objects as the timeline lists them: each thing the code defines with every line that places it, and a loop's or a many()'s copies, as one, and each thing the director added by hand (`added: true`); where each is in the scene. `locate` and `show` take one whole by its `sites` |
| `passes` | the film's own shaders at t: each one's stage, params and where the code placed it (to select it) |
| `stacks` | what a thing's or the camera's motion is made of: the code's operators and the director's changes; the scene's own settings (exposure, bloom, the sky…) as the code sets them and as the director changed them |
| `track` | how the camera and things move on screen over a span (speeds, rests, reversals), without rendering |
| `profile` | what drawing a frame takes: the film's code, its layers, each of the GPU's passes (the film's own by label), as the viewer or a master draws it |
| `prerender` | whether the viewer renders the rest of the film in the background (the editor's Pre-render, on by default, off on its Layout page): turn it off before timing the renderer, so the fill does not share the GPU, and on again after |
| `timeline`, `write_timeline` | the timeline file (cues, music, mixer, overrides; a notes clip's notes as how many); writing it keeps it as a version of the project, and fails where the director changed it since you read it |
| `history`, `restore`, `tag` | the project's versions, each its timelines and code together: what each changed (a diff), what changed since one (your last draft's), and the whole project brought back to one; a tag names a version, as git's do, and stands for it in either |
| `notes`, `write_notes` | notes clips as text in bars and beats: read a part, write one (or some of its bars) |
| `retime`, `reattach` | everything after a time moved when a scene's length changes; a change your code edit orphaned put back on its code |
| `media` | what the director brought in (the assets panel) |
| `music` | the songs as the studio heard them: tempo, bars, drops and parts, in film time; the tempo grid (Detected follows the music) |
| `sounds` | what sound files are like, by numbers and in words; or where each sound the timeline plays peaks, against the beat and the cues |
| `pitch` | the notes a recording plays (polyphonic), and where a note sounds alone its tuning to the cent; as notation too |
| `mixer` | the mixer as the Mixer panel shows it: each strip's volume, pan, mute, solo, effects (every param in its units) and sends; changed by strip name, checked first |
| `levels` | the mix's loudness: the film's, each span's, each track's, a voice over everything else; by octave, and what drives the master; of a variant too |
| `bounce` | the mix, or tracks alone, as a WAV in `renders/` |
| `instruments`, `set_instrument`, `audition` | each track's instrument, which plays its notes clips — the Ephemeris Sampler or a plugin (Vial, the studio's synth), alike: its parameters in their own words, what it holds and what is wrong with it; changed (checked first), automated, or heard on a phrase |
| `depth` | photos cut by depth into far, mid and near layers in `assets/depth`, for parallax (place them with `elements/depth.js`) |
| `show` | point the director's studio at something, with a note |
| `check`, `render_draft` | the quality gates; a draft video |
| `reference` | what a name in the engine or its elements is, where, and how it is called |
| `manual` | this manual and the agent skills, by chapter (also as MCP resources) |

Film code is shared project source: agents edit `projects/<name>/film.js` with their file tools, while the person can
inspect and direct the same code and timeline. The studio watches it and renders what changed. Read the [motion
chapter](motion.md) and `skill/engine` before writing film code; keep the director's cues and overrides.
