// Pi as the studio's agent: the Pi SDK (@earendil-works/pi-coding-agent) in the studio's own process, signed in as Pi is
// on this machine (its folder: ~/.pi/agent, or PI_CODING_AGENT_DIR — auth.json and models.json, the pi command line's
// sign-ins: ChatGPT's Codex, Anthropic, Copilot, Gemini, API keys, local servers), in the workspace with the workspace's
// own instructions and skills only (not this machine's Pi extensions, packages, skills or system prompt: as Claude Code
// runs with the project's settings only), the Ephemeris MCP server's tools declared to it, and each tool call through the
// studio's gate — looking, editing files and the studio's tools without asking; anything else (a command) asked of the
// director in Ask first, and in Auto decided by the model without a human prompt. Bypass permissions skips the gate.
// Its conversations are Pi's (pi --resume in the workspace lists them), marked as the
// panel's with the project each began in.
import fs from 'node:fs';
import path from 'node:path';
import { createAgentSession, createMcpExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { config, configure } from '../workspace.mjs';
import { title, clean, brief, resultParts, said } from './shared.mjs';
import { JUDGE, judgeInput, judgeTool } from './permissions.mjs';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// tools that only look, or edit files (each change to a film's code is kept in its history), or are the studio's own:
// never asked about (open selects a timeline only for this agent)
const FREE = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const free = (name) => FREE.has(name) || /^mcp__ephemeris__/.test(name);
// Pi's own tools as the panel names tools (Claude Code's names, and their inputs)
const AS = { read: 'Read', edit: 'Edit', write: 'Write', bash: 'Bash', grep: 'Grep', find: 'Glob', ls: 'LS' };
const shown = (name, input = {}) => ({ name: AS[name] ?? name, input: brief(input.path != null ? { ...input, file_path: input.path } : input) });

/** ctx: what the studio gives every harness (tools/agent.mjs). */
export function piHarness({ root, emit, ask, permissions, prompt, project, mcp, settings = config, setSettings = configure }) {
  const agentDir = getAgentDir();
  // Pi's own choices on this machine (its default model and thinking), as the pi command line keeps them
  const own = () => { try { return JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')); } catch { return {}; } };
  let runtime = null;   // (Pi's models and sign-ins, loaded once)
  const models = () => (runtime ??= ModelRuntime.create({ agentDir }).catch((e) => { runtime = null; throw e; }));
  const chosen = () => settings().piModel || (own().defaultProvider && own().defaultModel ? `${own().defaultProvider}/${own().defaultModel}` : null);
  async function find(value) {
    const rt = await models(), all = await rt.getAvailable();
    const [provider, ...id] = String(value ?? '').split('/');
    return all.find((m) => m.provider === provider && m.id === id.join('/')) ?? all[0] ?? null;
  }
  let shownModel = null;   // (the model chosen, as found: for the levels it thinks at)
  const effort = () => (LEVELS.includes(settings().piEffort) ? settings().piEffort : null);
  // its own thinking level for a model when the panel says default: Pi's, as its settings keep it
  const ownLevel = (m) => own().modelThinkingLevels?.[`${m.provider}/${m.id}`] ?? own().defaultThinkingLevel ?? 'medium';

  // ---------- a conversation
  function start({ resume = null, project: began = null }) {
    let session = null, done;
    const s = { id: resume, busy: false, named: !!resume, allowed: new Set(), run: null, over: new Promise((r) => { done = r; }) };
    // Looking, editing and studio tools stay permission-free. Auto returns an allow/deny decision to Pi; only Ask first
    // opens a permission prompt. A judge outage returns a retriable tool error, never an implicit approval or denial.
    async function gate(e) {
      if (permissions() === 'bypass' || free(e.toolName)) return undefined;
      const key = e.toolName === 'bash' ? `bash:${e.input?.command}` : e.toolName, signal = s.run?.abort.signal;
      if (s.allowed.has(key)) return undefined;
      if (permissions() === 'auto') return judgeTool(() => judge(e, signal), signal);
      const { name, input } = shown(e.toolName, e.input);
      const a = await ask(name, input, { always: true, signal });
      if (a.reconsider) return gate(e);
      if (a.always) s.allowed.add(key);
      return a.allow ? undefined : { block: true, reason: a.message ?? 'The director said no.' };
    }
    async function judge(e, signal) {
      const m = session.model, rt = await models();
      const r = await rt.completeSimple(m, { systemPrompt: JUDGE, messages: [{ role: 'user', content: [{ type: 'text', text: judgeInput(root, s.last, e.toolName, e.input) }], timestamp: Date.now() }] }, { reasoning: clampThinkingLevel(m, 'off'), signal });
      if (r.stopReason !== 'stop') throw new Error(r.errorMessage || 'The judge did not finish.');
      return r.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
    }

    function listen(ev) {
      if (ev.parentToolCallId) return;   // (a tool's own calls)
      if (ev.type === 'agent_start' && !s.run) {
        s.run = { t0: Date.now(), turns: 0, error: null, abort: new AbortController() };
        s.id = session.sessionId; s.busy = true;
        emit({ type: 'session', id: s.id, model: session.model ? `${session.model.provider}/${session.model.id}` : '' });
      } else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') emit({ type: 'delta', text: ev.assistantMessageEvent.delta });
      else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        for (const b of ev.message.content ?? []) {
          if (b.type === 'text' && b.text.trim()) emit({ type: 'text', text: b.text });
          if (b.type === 'toolCall') emit({ type: 'tool', id: b.id, ...shown(b.name, b.arguments) });
        }
        if (s.run) s.run.error = ev.message.stopReason === 'error' ? ev.message.errorMessage || 'The model failed.' : null;
      } else if (ev.type === 'turn_end' && s.run) s.run.turns++;
      else if (ev.type === 'tool_execution_end') emit({ type: 'result', id: ev.toolCallId, ok: !ev.isError, ...resultParts(ev.result?.content) });
      else if (ev.type === 'agent_settled' && s.run) {
        const r = s.run;
        s.run = null; s.busy = false;
        // (named by its first message once its first turn is done)
        if (!s.named && s.first) { session.setSessionName(title(s.first)); s.named = true; }
        if (r.error && !ev.aborted) emit({ type: 'error', text: r.error });
        emit({ type: 'done', ok: !ev.aborted && !r.error, error: ev.aborted ? 'stopped' : r.error ? 'failed' : null, cost: session.getSessionStats().cost || null, turns: r.turns, ms: Date.now() - r.t0 });
      }
    }

    const ready = (async () => {
      const rt = await models();
      const model = await find(chosen());
      const settingsManager = SettingsManager.inMemory({});
      const inRoot = (f) => path.resolve(f).startsWith(root + path.sep);
      const resourceLoader = new DefaultResourceLoader({
        cwd: root, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [
          // (the studio's MCP server alone, not this machine's mcp.json)
          createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }),
          { name: 'ephemeris', factory: (pi) => { pi.registerMcpServer('ephemeris', { ...mcp, exposure: 'direct', timeout: 600 }); pi.on('tool_call', gate); } },
        ],
        skillsOverride: (b) => ({ ...b, skills: b.skills.filter((k) => inRoot(k.filePath)) }),
        agentsFilesOverride: (b) => ({ agentsFiles: b.agentsFiles.filter((f) => !path.resolve(f.path).startsWith(agentDir + path.sep)) }),
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () => [prompt()],
      });
      await resourceLoader.reload();
      const file = resume && SessionManager.findById(root, resume);
      if (resume && !file) throw new Error('That conversation is not there any more.');
      const sessionManager = file ? SessionManager.open(file) : SessionManager.create(root);
      if (!file) sessionManager.appendCustomEntry('ephemeris', { project: began ?? project() });
      ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: rt, ...(model && { model, thinkingLevel: clampThinkingLevel(model, effort() ?? ownLevel(model)) }), resourceLoader, settingsManager, sessionManager }));
      session.subscribe(listen);
      await session.bindExtensions({});
      s.id = session.sessionId;
      s.session = session;
    })();
    ready.catch((e) => { emit({ type: 'error', text: `Pi did not start: ${e?.message ?? e}` }); done(); });

    return Object.assign(s, {
      // the director's message ({ text, frame: { t, jpeg }, images: [{ type, data }] }); when: while Pi works, when it reads
      // it (next: once its current tool calls finish; later: once it has finished; now: it stops, and reads this)
      send({ text, frame, images }, when) {
        const content = [{ type: 'text', text }];
        if (frame) content.push({ type: 'text', text: `(The frame on screen, ${frame.t.toFixed(2)} s:)` }, { type: 'image', data: frame.jpeg.toString('base64'), mimeType: 'image/jpeg' });
        if (images.length) content.push({ type: 'text', text: `(${images.length === 1 ? 'An image' : `${images.length} images`} the director attached:)` }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.type })));
        s.last = text;
        ready.then(async () => {
          if (!session.isStreaming) return session.sendUserMessage(content);
          if (when === 'now') { s.run?.abort.abort(); await session.abort(); return session.sendUserMessage(content); }
          return session.sendUserMessage(content, { deliverAs: when === 'later' ? 'followUp' : 'steer' });
        }).catch((e) => { if (s.busy && !session?.isStreaming) s.busy = false; emit({ type: 'error', text: String(e?.message ?? e) }); });
      },
      stop: async () => { s.run?.abort.abort(); await ready.then(() => session.abort()).catch(() => {}); },
      setPermissions: () => {},
      end: async () => { await s.stop(); await ready.then(() => session.dispose()).catch(() => {}); done(); return s.over; },
    });
  }

  // ---------- the panel's past conversations: Pi's for the workspace, those marked as the panel's
  const mark = (file) => {
    try {
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(16384), n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"customType":"ephemeris","data":\{"project":"([^"]*)"\}/.exec(buf.subarray(0, n).toString('utf8'));
      return m ? { project: m[1] } : null;
    } catch { return null; }
  };
  const fileOf = (id) => SessionManager.findById(root, id);

  return {
    id: 'pi', label: 'Pi',
    permissionModes: () => ['auto', 'ask', 'bypass'],
    home: () => `Pi · ${agentDir}`,
    model: () => chosen() ?? (shownModel ? `${shownModel.provider}/${shownModel.id}` : ''),
    effort, efforts: () => (shownModel?.reasoning ? getSupportedThinkingLevels(shownModel) : LEVELS),
    async models() {
      const rt = await models(), all = await rt.getAvailable();
      shownModel = await find(chosen());
      return all.map((m) => ({ value: `${m.provider}/${m.id}`, name: m.name || m.id, description: [rt.getProvider(m.provider)?.name ?? m.provider, m.reasoning && 'thinks', m.input?.includes('image') && 'sees images'].filter(Boolean).join(' · ') }));
    },
    /** Whether Pi is ready here: what it is signed in to, by provider. */
    async status() {
      let rt;
      try { rt = await models(); } catch (e) { return { ready: false, detail: `Pi did not start: ${e.message}` }; }
      const all = await rt.getAvailable(), by = new Map();
      for (const m of all) by.set(m.provider, (by.get(m.provider) ?? 0) + 1);
      if (!by.size) return { ready: false, detail: 'Not signed in: /login openai is Sign in with ChatGPT (Codex), or sign in to another provider.', fix: './ephemeris pi, then /login', where: agentDir };
      return { ready: true, detail: [...by].map(([p, n]) => `${rt.getProvider(p)?.name ?? p} (${n})`).join(' · '), where: agentDir };
    },
    async setModel(v, s) {
      setSettings({ piModel: typeof v === 'string' && v ? v : null });
      const m = await find(chosen());
      shownModel = m;
      if (m && s?.session) await s.session.setModel(m);
    },
    async setEffort(e, s) {
      setSettings({ piEffort: LEVELS.includes(e) ? e : null });
      const m = s?.session?.model ?? shownModel;
      if (m && s?.session) s.session.setThinkingLevel(clampThinkingLevel(m, effort() ?? ownLevel(m)));
    },
    start,
    async conversations() {
      const all = await SessionManager.list(root).catch(() => []);
      return all.map((x) => ({ x, m: mark(x.path) })).filter(({ m, x }) => m && x.messageCount > 0)
        .map(({ x, m }) => ({ id: x.id, title: x.name || clean(x.firstMessage) || 'A conversation', project: m.project || null, at: x.modified.getTime() }));
    },
    async transcript(id) {
      const file = fileOf(id);
      if (!file) throw new Error('That conversation is not there any more.');
      const out = [];
      for (const e of SessionManager.open(file).getBranch().slice(-1200)) {
        const m = e.type === 'message' ? e.message : null;
        if (m?.role === 'user') {
          const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
          const you = said(blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), blocks.filter((b) => b.type === 'image'));
          if (you) out.push(you);
        } else if (m?.role === 'assistant') {
          for (const b of m.content ?? []) {
            if (b.type === 'text' && b.text.trim()) out.push({ type: 'text', text: b.text });
            if (b.type === 'toolCall') out.push({ type: 'tool', id: b.id, ...shown(b.name, b.arguments) });
          }
        } else if (m?.role === 'toolResult') out.push({ type: 'result', id: m.toolCallId, ok: !m.isError, ...resultParts(m.content) });
      }
      return out;
    },
    async rename(id, t, s) {
      if (s?.session && s.id === id) return s.session.setSessionName(title(t));
      const file = fileOf(id);
      if (file) SessionManager.open(file).appendSessionInfo(title(t));
    },
    async remove(id) { const file = fileOf(id); if (file) fs.rmSync(file, { force: true }); },
  };
}
