# The Ephemeris manual

One manual for a person and an agent working on the same editable audiovisual project: how the studio's timeline,
media, music, code and renderer fit together.

Ephemeris is a human-directed, agentic creative launchpad, not a prompt-and-reroll boundary. The agent can help
prototype and execute, while the person directs the work, changes it in the timeline, and keeps the result inspectable.
The frame/time model and WebGPU engine are the
technical substrate that makes that collaboration reproducible; they are not a limit on the kinds of work the project
can hold.

- [Motion: stacks, operators and lanes](motion.md): what moves is a stack of operators, shown as lanes you can grab.
- [Drawing: what ships, and your own](drawing.md): the rendering boundary is open; shipped primitives are ways to draw,
  not a required look.
- [Working with an agent](agents.md): the studio panel and MCP server, and how the agent works in the project.

More chapters move here from the agent skills (`.agents/skills/engine/`) as the studio grows.
