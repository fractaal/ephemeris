// Independent conversations in shared live projects. The registry owns their lifetimes, not an editor page.
// Each conversation has its own harness choices, approval requests, event stream and MCP target. Navigating the
// studio never ends a conversation or changes its tools' project. Harness transcripts remain the durable history.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, configure, STUDIO } from './workspace.mjs';
import { piHarness } from './agents/pi.mjs';
import { antigravityHarness } from './agents/antigravity.mjs';
import { panelPrompt, brief, title } from './agents/shared.mjs';
import { keepImage } from './agents/images.mjs';
import { AGENT_NAME, agentShort } from '../nle/model.js';

/** What the director calls the agent: this machine's name for it, or the studio's. */
const agentName = () => (typeof config().agentName === 'string' && config().agentName.trim().slice(0, 40)) || AGENT_NAME;
// The Claude Code harness is not in the published studio (Anthropic lets no other product offer sign-in with a Claude
// subscription): where its module or its SDK is missing, the panel offers the other harnesses, the first the default.
const claude = await import('./agents/claude.mjs').then((m) => m.claudeHarness, (e) => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && /agents[\\/]claude\.mjs|claude-agent-sdk/.test(e.message)) return null;
  throw e;
});
const FACTORIES = { ...(claude && { claude }), pi: piHarness, antigravity: antigravityHarness };

/** All live conversations, grouped by project. `open(project, timeline)` returns that timeline, without navigating
 *  any editor. `emit(project, type, data)` reaches its editors even if they show another timeline of the project. */
export function createAgents({ root, studio, open, emit, factories = FACTORIES }) {
  const live = new Map(), resumptions = new Map(), listed = new Map();
  let modelList = null;
  const list = (project) => [...live.values()].filter((a) => !project || a.project === project).map((a) => a.summary());
  const changed = (project) => emit(project, 'agents', list(project));
  function add(project, timeline = 'main') {
    const id = randomUUID();
    const a = createAgent({ root, studio, id, project, timeline, factories, listed, open: (tid) => open(project, tid),
      notify: (e) => {
        emit(project, 'agent', e);
        if (!['delta', 'text', 'tool', 'result'].includes(e.type)) changed(project);
      } });
    live.set(id, a); changed(project);
    return a;
  }
  function get(project, id, timeline) {
    if (id) {
      const a = live.get(id);
      if (!a || a.project !== project) throw new Error('That agent is no longer open in this project. Choose another agent.');
      return a;
    }
    return [...live.values()].find((a) => a.project === project) ?? add(project, timeline);
  }
  return {
    add, get, list,
    models: (a) => (modelList ??= a.models().catch((e) => { modelList = null; throw e; })),
    refreshModels: () => { modelList = null; },
    target(id) {
      const a = live.get(id);
      if (!a) throw new Error('That agent is no longer open. Start or resume it from its project.');
      return a;
    },
    async resume(project, timeline, info) {
      const running = [...live.values()].find((a) => a.project === project && a.summary().session === info.id && a.summary().harness === info.harness);
      if (running) return running;
      const key = JSON.stringify([project, info.harness, info.id]);
      if (!resumptions.has(key)) {
        const a = add(project, timeline);
        resumptions.set(key, a.resume(info).then(() => a, async (e) => {
          live.delete(a.id); await a.close(); changed(project); throw e;
        }).finally(() => resumptions.delete(key)));
      }
      return resumptions.get(key);
    },
    async close(project, id) {
      const a = get(project, id);
      await a.close(); live.delete(a.id); changed(project);
    },
    async rename(project, info) {
      const a = [...live.values()].find((a) => a.project === project && a.summary().session === info.id && a.summary().harness === info.harness) ?? get(project);
      return a.rename(info);
    },
    async remove(project, info) {
      const a = [...live.values()].find((a) => a.project === project && a.summary().session === info.id && a.summary().harness === info.harness) ?? get(project);
      await a.remove(info); changed(project);
    },
    async closeAll() { await Promise.all([...live.values()].map((a) => a.close())); live.clear(); },
    /** A note of the studio's to every agent in the project (the film's frames slow to draw, say): see createAgent's note. */
    note(project, text) { for (const a of live.values()) if (a.project === project) a.note(text); },
  };
}

/** One conversation. `open(timeline)` supplies the context shown with a message, not a global current project. */
export function createAgent({ root, studio, id, project, timeline, open, notify, factories = FACTORIES, listed = new Map() }) {
  // Machine preferences seed a new agent; subsequent changes affect only it and defaults for future agents.
  const preferences = { ...config() };
  const settings = () => preferences;
  const setSettings = (change) => { Object.assign(preferences, change); configure(change); };
  const permissions = () => how(shown()).permissions;
  let caption = 'New agent', target = timeline, disposed = false;
  let session = null;   // the conversation going on: its harness's ({ id, busy, first, harness, send, stop, end, over, … })
  let resuming = null;  // a past conversation to continue with the next message ({ id, harness, title, project })
  let events = [];      // the conversation as the panel draws it, for an editor that opens later
  const notes = [];     // the studio's notes (note) the agent has not read yet: given with the director's next message
  const asks = new Map();
  let seq = 0;
  // (a block's streamed pieces are kept only until the block comes whole: an editor that opens later draws the block,
  // and what it is sent of a long conversation reaches further back; each image is kept once, and named: images.mjs)
  const record = (e) => {
    if (e.images?.length) e.images = e.images.map(keepImage);
    Object.assign(e, { n: ++seq, agent: id, project, timeline: target });
    if (e.type === 'text') events = events.filter((x) => x.type !== 'delta');
    events.push(e);
    if (events.length > 4000) events = events.slice(-3000);
    return e;
  };
  const emit = (e) => { record(e); if (e.type === 'session' || e.type === 'done') listed.clear(); if (!disposed) notify({ ...e, agent: id, project, timeline: target }); };
  // each harness's list of the panel's conversations, kept a few seconds by the registry for all its agents: a click on one
  // lists them again to find it, just after the panel listed them to show it (0.12 to 0.23 s on 95 transcripts); a turn's
  // start or end, a rename or a delete lists them afresh
  const listOf = (h) => {
    const was = listed.get(h.id);
    if (was && Date.now() - was.at < 5000) return was.list;
    const list = h.conversations();
    listed.set(h.id, { at: Date.now(), list });
    list.catch(() => { if (listed.get(h.id)?.list === list) listed.delete(h.id); });
    return list;
  };

  // what the agent wants to do, asked of the director (the panel's Allow, Always allow, Don't): resolves { allow, always };
  // or a question with choices of its own (options: [{ id, name }]): resolves { allow, option } (the conversation ending
  // or its step stopped: not allowed)
  function ask(name, input, { always = false, signal, options } = {}) {
    const id = `a${++seq}`;
    return new Promise((resolve) => {
      if (disposed || signal?.aborted) return resolve({ allow: false, message: 'Stopped.' });
      asks.set(id, { resolve, permission: !options?.length });
      emit({ type: 'ask', id, name, input: brief(input), always, ...(options?.length && { options }) });
      signal?.addEventListener('abort', () => { if (asks.delete(id)) { emit({ type: 'answered', id, allow: false }); resolve({ allow: false, message: 'Stopped.' }); } });
    });
  }
  // the environment the agent runs in: the studio's, but not a Claude Code session's own (the studio started from inside
  // one: its Claude would be taken for that session's child, and report to it)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'CLAUDE_PID' && !k.startsWith('CLAUDE_CODE_')));
  // what every harness is given
  const ctx = {
    root, studio, env, emit, ask, permissions, settings, setSettings,
    prompt: () => panelPrompt(agentName() === AGENT_NAME ? `${AGENT_NAME} (${agentShort(AGENT_NAME)} for short)` : agentName(), project),
    project: () => project,
    // MCP transports inherit only a small environment allowlist: name the workspace and studio overrides explicitly.
    mcp: { command: process.execPath, args: [path.join(STUDIO, 'tools', 'mcp.mjs'), '--studio', studio, '--agent', id],
      env: { ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('EPHEMERIS_'))), EPHEMERIS_WORKSPACE: root,
        ...(env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } },
  };
  const harnesses = Object.fromEntries(Object.entries(factories).map(([id, make]) => [id, make(ctx)]));
  const chosen = () => harnesses[preferences.agentHarness] ?? Object.values(harnesses)[0];
  // the harness the panel shows: the conversation's (going on, or to continue), else the one chosen
  const shown = () => harnesses[session?.harness ?? resuming?.harness] ?? chosen();
  // Keep a saved mode within the current harness's capabilities (Antigravity still only asks).
  const modes = (h) => h.permissionModes?.() ?? ['auto', 'ask'];
  const how = (h) => ({ permissionModes: modes(h), permissions: modes(h).includes(preferences.agentPermissions) ? preferences.agentPermissions : modes(h)[0] });

  function start() {
    const h = resuming ? harnesses[resuming.harness] ?? chosen() : chosen();
    const s = h.start({ resume: resuming?.id ?? null, project: resuming ? resuming.project ?? '' : null });
    s.harness = h.id;
    session = s; resuming = null;
    s.over.finally(() => {
      if (session !== s) return;
      session = null;
      if (s.id) resuming = { id: s.id, harness: s.harness, project, title: caption };
      for (const [id, { resolve }] of asks) { resolve({ allow: false, message: 'The conversation ended.' }); asks.delete(id); emit({ type: 'answered', id, allow: false }); }
      emit({ type: 'ended' });
    });
  }
  // the conversation going on now, ended (resolves once it has stopped)
  async function end() {
    const s = session;
    if (!s) return;
    session = null;
    for (const [id, { resolve }] of asks) { asks.delete(id); resolve({ allow: false, message: 'The conversation ended.' }); emit({ type: 'answered', id, allow: false }); }
    let timer;
    try { await Promise.race([s.end(), new Promise((r) => { timer = setTimeout(r, 8000); })]); } finally { clearTimeout(timer); }
  }
  async function reset() { await end(); resuming = null; caption = 'New agent'; events = []; emit({ type: 'reset' }); }

  return {
    id, project,
    target() { return { name: project, tid: target }; },
    setTarget(tid) { target = tid; emit({ type: 'target', timeline: tid }); },
    summary() { return { id, project, timeline: target, title: caption, busy: !!session?.busy, waiting: asks.size > 0, session: session?.id ?? resuming?.id ?? null, harness: shown().id }; },
    state() {
      const h = shown();
      return {
        ...this.summary(), busy: !!session?.busy, session: session?.id ?? resuming?.id ?? null, name: agentName(), harness: h.id, harnesses: Object.values(harnesses).map((x) => ({ id: x.id, label: x.label })),
        model: h.model(), effort: h.effort(), efforts: h.efforts(), ...how(h), home: h.home(), events: events.slice(-1500),
      };
    },
    /** The models each harness can be ({ harness, label, models: [{ value, name, description }], error }), as each lists them. */
    async models() {
      return Promise.all(Object.values(harnesses).map((h) => h.models().then((models) => ({ harness: h.id, label: h.label, experimental: h.experimental, models }), (e) => ({ harness: h.id, label: h.label, experimental: h.experimental, models: [], error: String(e?.message ?? e) }))));
    },
    /** Which model from now on (null: the harness's own default), the conversation going on now too; a model of another
     *  harness makes it the one chosen, and the conversation going on ends (a new one begins with the next message). */
    async setModel({ model: m, harness }) {
      const h = harnesses[harness] ?? shown();
      if (h !== shown()) { await reset(); setSettings({ agentHarness: h.id }); }
      else if (h !== chosen()) setSettings({ agentHarness: h.id });
      await h.setModel(typeof m === 'string' && m ? m : null, session?.harness === h.id ? session : null);
      emit({ type: 'configured' });
      return { harness: h.id, model: h.model(), effort: h.effort(), efforts: h.efforts(), ...how(h), home: h.home() };
    },
    /** How hard it thinks from now on, the conversation going on now too: a level, or null (its own). */
    async setEffort({ effort: e }) {
      const h = shown();
      await h.setEffort(e || null, session?.harness === h.id ? session : null);
      return { effort: h.effort() };
    },
    /** How it may act from now on, the conversation going on now too. */
    async setPermissions({ permissions: p }) {
      setSettings({ agentPermissions: modes(shown()).includes(p) ? p : modes(shown())[0] });
      await session?.setPermissions(permissions());
      // Pi's unattended modes also re-evaluate already waiting tool calls. Real questions stay unanswered.
      if (shown().id === 'pi' && permissions() !== 'ask') for (const [id, { resolve, permission }] of asks) if (permission) {
        asks.delete(id);
        emit({ type: 'answered', id, automatic: true });
        resolve({ reconsider: true });
      }
      return how(shown());
    },
    /** The agent as the settings show it: its name, the harness chosen, and each harness's state here (signed in, as
     *  whom; what to do if not). */
    async settings() {
      const status = await Promise.all(Object.values(harnesses).map((h) => h.status().catch((e) => ({ ready: false, detail: String(e?.message ?? e) }))));
      return { name: agentName(), defaultName: AGENT_NAME, harness: harnesses[config().agentHarness] ? config().agentHarness : Object.keys(harnesses)[0], harnesses: Object.values(harnesses).map((h, i) => ({ id: h.id, label: h.label, experimental: h.experimental, ...status[i] })) };
    },
    /** The shared name or default harness for new conversations; or what a
     *  harness's settings do (act: { harness, id }: installing it, signing in or out), answered once it is done. */
    async configure({ name, harness, act }) {
      if (typeof name === 'string') configure({ agentName: name.trim().slice(0, 40) || null });
      if (harnesses[harness]) configure({ agentHarness: harness });
      if (act && harnesses[act.harness]?.act) await harnesses[act.harness].act(act.id);
      return this.settings();
    },
    /** The panel's past conversations, every harness's (newest first): their titles, the harness, the project each began
     *  in, when. */
    async conversations() {
      const lists = await Promise.all(Object.values(harnesses).map((h) => listOf(h).then((l) => l.map((c) => ({ ...c, harness: h.id, via: h.label })), () => [])));
      const now = session?.id ?? resuming?.id;
      return lists.flat().filter((c) => !c.project || c.project === project).sort((a, b) => b.at - a.at).map((c) => ({ ...c, current: c.id === now }));
    },
    /** A past conversation, shown again; the next message continues it (with its harness, chosen from now on). */
    async resume({ id, harness }) {
      if (session?.id === id) return { ok: true };
      const info = (await this.conversations()).find((c) => c.id === id && (!harness || c.harness === harness));
      if (!info) throw new Error('That conversation is not in this project. Open its project to continue it.');
      const h = harnesses[info.harness] ?? shown();
      const shownEvents = await h.transcript(id).catch((e) => { throw new Error(`Could not read that conversation: ${e.message}`); });
      if (!shownEvents.length) throw new Error('That conversation has nothing in it any more.');
      await end();
      events = [];
      emit({ type: 'reset' });
      emit({ type: 'resumed', id, title: info?.title ?? 'A conversation', project: info?.project ?? null, harness: h.id, via: h.label });
      // (kept for the panel, which reads them with the agent's state: not sent to every editor one at a time)
      for (const e of shownEvents) record(e);
      caption = info.title ?? 'A conversation';
      resuming = { id, harness: h.id, title: info?.title, project: info?.project ?? null };
      if (h !== chosen()) setSettings({ agentHarness: h.id });
      emit({ type: 'ended' });
      return { ok: true };
    },
    async rename({ id, title: t, harness }) {
      if (!(await this.conversations()).some((c) => c.id === id && c.harness === harness)) throw new Error('That conversation is not in this project.');
      const h = harnesses[harness] ?? shown();
      await h.rename(id, t, session?.harness === h.id ? session : null);
      listed.clear();
      if (id === (session?.id ?? resuming?.id)) { if (session) session.named = true; caption = title(t); emit({ type: 'named', title: caption }); }
      return { ok: true };
    },
    async remove({ id, harness }) {
      if (!(await this.conversations()).some((c) => c.id === id && c.harness === harness)) throw new Error('That conversation is not in this project.');
      const h = harnesses[harness] ?? shown();
      // (the conversation going on now ends first: its process writes to the transcript as it stops)
      if (session?.id === id || resuming?.id === id) { await reset(); }
      await h.remove(id);
      listed.clear();
      return { ok: true };
    },
    /** A note of the studio's: shown in the panel, and read by the agent as soon as its current step finishes while it
     *  works, or else with the director's next message (it does not start a turn of its own). */
    note(text) {
      emit({ type: 'studio', text });
      if (session?.busy) session.send({ text: `<studio>\n${text}\n</studio>`, images: [] }, 'next');
      else notes.push(text);
    },
    /** The director's message, with the studio's context (and the frame on screen) */
    // when: while the agent works, when it reads this — next (as soon as its current step finishes), later (once it has
    // finished: a new turn), now (what can wait moves to the background, or it stops, and reads this)
    async send({ text, context = {}, frame = true, images = [], when = 'next' }) {
      if (!text?.trim()) return { error: 'Nothing to send' };
      if (disposed) throw new Error('That agent has ended. Start another agent.');
      const o = await open(context.timeline ?? target);
      if (!session) { target = context.timeline ?? target; start(); }
      const s = session;
      s.first ??= text.trim();
      if (caption === 'New agent') caption = title(text);
      const jpg = frame && Number.isInteger(context.frame) ? await o?.frameJpeg(context.frame).catch(() => null) : null;
      const mine = (images ?? []).slice(0, 6).map((u) => /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(u)).filter(Boolean);
      const was = s.busy;
      s.busy = true;
      emit({ type: 'you', text: text.trim(), chips: context.chips ?? [], frame: jpg ? context.frame : null, images: mine.map((m) => m[0]), when });
      s.send({ text: `${studioContext(o, context, notes.splice(0))}\n\n${text.trim()}`, frame: jpg && { t: +context.t, jpeg: jpg }, images: mine.map(([, type, data]) => ({ type, data })) }, was ? when : null);
      return { ok: true };
    },
    /** The director's answer to a tool the agent asked to run (always: for the rest of the conversation), or to its
     *  question (option: the choice's id). */
    answer({ id, allow, always, option }) {
      const pending = asks.get(id);
      if (!pending) return { error: 'Nothing is waiting for that' };
      const { resolve } = pending;
      asks.delete(id);
      emit({ type: 'answered', id, allow: !!(allow || option), always: !!always, ...(option && { option }) });
      resolve(option ? { allow: true, option } : allow ? { allow: true, always: !!always } : { allow: false, message: 'The director said no.' });
      return { ok: true };
    },
    async stop() { await session?.stop(); return { ok: true }; },
    /** A new conversation (the old one ends). */
    async reset() { await reset(); return { ok: true }; },
    async close() { await end(); disposed = true; await Promise.all(Object.values(harnesses).map((h) => h.close?.())); },
  };
}

// what the studio shows, as a message's preface; notes: the studio's own since the last (note)
function studioContext(o, c, notes = []) {
  const L = ['<studio>'];
  if (o) L.push(`Open: ${o.name}/${o.tid} (projects/${o.name}; its film page ${o.url ?? '?'}).`);
  if (c.t != null) L.push(`Playhead: ${(+c.t).toFixed(2)} s${Number.isInteger(c.frame) ? ` (frame ${c.frame})` : ''}.`);
  if (c.sel?.sites) L.push(`Selected in the viewer: the whole object ${c.sel.object || c.sel.label || 'a thing'}${c.sel.kind ? ` (${c.sel.kind})` : ''}, every copy of it${c.sel.count ? ` (${c.sel.count} here)` : ''}, placed by ${c.sel.sites.join(', ')} (locate/show name it { sites: ${JSON.stringify(c.sel.sites)} }; the director's changes to it are overrides on { sites }). Its values are read from the copy placed at ${c.sel.at} (nth: ${c.sel.nth ?? 0}${c.sel.key != null ? `, key: ${JSON.stringify(c.sel.key)}` : ''}).`);
  else if (c.sel) L.push(`Selected in the viewer: ${c.sel.label || c.sel.kind || 'a thing'}${c.sel.kind ? ` (${c.sel.kind})` : ''}, placed at ${c.sel.at}${c.sel.copies > 1 ? `, copy ${(c.sel.copy ?? 0) + 1} of ${c.sel.copies}` : ''} (pick/locate/stacks name it { at: "${c.sel.at}", nth: ${c.sel.nth ?? 0}${c.sel.key != null ? `, key: ${JSON.stringify(c.sel.key)}` : ''} }).`);
  if (c.also?.length) L.push(`Also selected in the viewer: ${c.also.join('; ')}.`);
  if (c.lane) L.push(`Selected in the timeline: ${c.lane}.`);
  if (c.cues?.length) L.push(`Selected cues: ${c.cues.join('; ')}.`);
  if (c.clips?.length) L.push(`Selected clips: ${c.clips.join('; ')}.`);
  if (c.notes) L.push(`Selected notes in the piano roll: ${c.notes}.`);
  if (c.code) L.push(`Selected in the Code panel: ${c.code} (the project's file and lines).`);
  if (c.range) L.push(`In/out range: ${c.range}.`);
  if (c.frameNote) L.push(c.frameNote);
  L.push(...notes);
  L.push('</studio>');
  return L.join('\n');
}
