// Antigravity as the studio's agent: Google's own ACP server for it (antigravity-acp, as the Agent Client Protocol's
// registry lists it, for apps that speak ACP; installed once, from the settings, into ~/.cache/ephemeris/agents), spoken
// to over ACP (@agentclientprotocol/sdk). It is signed in as the director signs it in from the settings — Google, Gemini
// Enterprise, a Gemini API key (GEMINI_API_KEY) or the Enterprise Agent Platform — and keeps its credentials itself
// (~/.gemini/antigravity-acp). It works in the workspace with the Ephemeris MCP server's tools and the panel's
// instructions after its own; of a tool's result it tells the panel only a line of its own (no frames to show). It edits files without asking (its Auto Edit mode); it has no mode that judges a
// command itself, so it asks before each one whichever the panel's choice; what it asks (a command, a question with
// choices) comes to the panel. ACP takes one message at a time: one sent while it works waits for its turn's end. Its
// sessions are its own; their titles and the projects they began in are the panel's (CONFIG's folder:
// antigravity.json), as its sessions carry neither.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractZip } from '../archive.mjs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as acp from '@agentclientprotocol/sdk';
import { config, configure, CONFIG } from '../workspace.mjs';
import { title, brief, resultParts, said } from './shared.mjs';

const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const AGENTS = path.join(os.homedir(), '.cache', 'ephemeris', 'agents', 'antigravity-acp');
const PLATFORM = { 'linux-x64': 'linux-x86_64', 'linux-arm64': 'linux-aarch64', 'darwin-arm64': 'darwin-aarch64', 'darwin-x64': 'darwin-x86_64', 'win32-x64': 'windows-x86_64', 'win32-arm64': 'windows-aarch64' }[`${process.platform}-${process.arch}`];
const HOME = path.join(process.env.GEMINI_HOME ?? path.join(os.homedir(), '.gemini'), 'antigravity-acp');
const INDEX = path.join(path.dirname(CONFIG), 'antigravity.json');
const processes = new Set();
process.on('exit', () => { for (const p of processes) p.kill(); });
const SIGN_IN = { 'oauth-personal': 'Google', 'oauth-business': 'Gemini Enterprise', 'gemini-api-key': 'a Gemini API key', 'agent-platform': 'Gemini Enterprise Agent Platform', gateway: 'an AI gateway' };
// what a personal Google sign-in may mean here (Antigravity's terms and FAQ)
const PERSONAL = 'On a personal Google account, Google supports ACP editors (Zed, JetBrains) but not third-party apps or agents that route prompts into Antigravity; which of those Ephemeris counts as, Google has not said. A Gemini API key or an Enterprise sign-in is plainly allowed.';
// (a question it asks is a step of its own too, named so: the panel shows the question alone)
const ASKS = 'interaction_';
// tools that only look, and the studio's own: answered here, not asked (open is local to the agent)
const free = (name) => ['Read', 'Grep', 'LS', 'Glob'].includes(name) || /^mcp__ephemeris__/.test(name);

// the panel's record of the sessions it began: { [id]: { title, project, at, root } }
const index = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; } };
const keep = (id, x) => { const all = index(); if (x) all[id] = { ...all[id], ...x }; else delete all[id]; fs.mkdirSync(path.dirname(INDEX), { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(all, null, 2) + '\n'); };

// a step as the panel names steps (Claude Code's names, and their inputs): the studio's tools by their MCP names
function shown(u) {
  const raw = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}, where = u.locations?.[0]?.path;
  const mcp = u._meta?.mcp;
  if (mcp?.tool) { const { arguments: _, ...args } = raw; return { name: mcp.server === 'ephemeris' ? `mcp__ephemeris__${mcp.tool}` : `${mcp.server}_${mcp.tool}`, input: brief(args) }; }
  if (u.kind === 'execute') return { name: 'Bash', input: brief({ command: raw.CommandLine ?? raw.command ?? u.title }) };
  if (u.kind === 'read') return { name: 'Read', input: brief({ file_path: where ?? raw.AbsolutePath ?? u.title }) };
  if (u.kind === 'edit') return { name: 'Edit', input: brief({ file_path: where ?? raw.TargetFile ?? u.title }) };
  if (u.kind === 'search') return { name: 'Grep', input: brief({ pattern: raw.Query ?? raw.Pattern ?? u.title }) };
  if (u.kind === 'fetch') return { name: 'WebFetch', input: brief({ url: raw.Url ?? raw.url ?? u.title }) };
  return { name: u.title || u.name || 'a step', input: brief(raw) };
}
// a tool's result's blocks (ACP's content, else its raw output as text)
const blocks = (u) => (u.content?.length ? u.content.filter((c) => c.type === 'content').map((c) => c.content) : u.rawOutput != null ? [{ type: 'text', text: typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput) }] : []);

/** ctx: what the studio gives every harness (tools/agent.mjs). */
export function antigravityHarness({ root, env, emit, ask, prompt, project, mcp, settings = config, setSettings = configure }) {
  let conn = null;         // the ACP server's process and connection: { c, p, ready, routes: Map(session id → { update, permit }), init }
  let options = null;      // the config options of the last session seen (its models and thinking levels)
  let spare = null;        // a session opened to learn the models, kept for the next conversation
  let installing = null;   // { done, total, unpacking } while it installs

  // ---------- installed (the version the registry lists, for this machine), and installing
  function installed() {
    try {
      const v = fs.readdirSync(AGENTS).filter((d) => fs.existsSync(path.join(AGENTS, d, 'ready.json'))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      return v ? { version: v, dir: path.join(AGENTS, v), ...JSON.parse(fs.readFileSync(path.join(AGENTS, v, 'ready.json'), 'utf8')) } : null;
    } catch { return null; }
  }
  const listed = async () => {
    const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(8000) });
    const a = (await r.json()).agents?.find((x) => x.id === 'antigravity-acp');
    const bin = a?.distribution?.binary?.[PLATFORM];
    return bin ? { version: a.version, ...bin } : null;
  };
  async function install() {
    if (installing) throw new Error('It is installing already.');
    const a = await listed();
    if (!a) throw new Error(`Antigravity has no ACP server for this machine (${process.platform} ${process.arch}).`);
    const dir = path.join(AGENTS, a.version), zip = path.join(dir, 'download.zip');
    installing = { done: 0, total: 0 };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const r = await fetch(a.archive);
      if (!r.ok) throw new Error(`Could not download ${a.archive}: ${r.status}`);
      installing.total = +r.headers.get('content-length') || 0;
      await pipeline(Readable.fromWeb(r.body), async function* (src) { for await (const b of src) { installing.done += b.length; yield b; } }, fs.createWriteStream(zip));
      installing.unpacking = true;
      extractZip(zip, dir);
      fs.rmSync(zip);
      fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ cmd: a.cmd, args: a.args ?? [] }) + '\n');
      // (older versions go: a gigabyte each)
      for (const v of fs.readdirSync(AGENTS)) if (v !== a.version) fs.rmSync(path.join(AGENTS, v), { recursive: true, force: true });
      await close();
    } finally { installing = null; }
  }

  // ---------- the connection: one process for every session, started when one is needed
  function connect() {
    if (conn) return conn.ready;
    const at = installed();
    if (!at) return Promise.reject(new Error('Antigravity is not installed: install it in the settings.'));
    const p = spawn(path.resolve(at.dir, at.cmd), at.args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    processes.add(p);
    let said = '';
    p.stderr.on('data', (d) => { said = (said + d).slice(-4000); });
    const routes = new Map();
    const c = new acp.ClientSideConnection(() => ({
      async sessionUpdate({ sessionId, update }) { routes.get(sessionId)?.update(update); },
      async requestPermission(params) { return (await routes.get(params.sessionId)?.permit(params)) ?? { outcome: { outcome: 'cancelled' } }; },
    }), acp.ndJsonStream(Writable.toWeb(p.stdin), Readable.toWeb(p.stdout)));
    const me = conn = { c, p, routes };
    p.on('exit', (code) => {
      processes.delete(p);
      if (conn === me) conn = null;
      spare = null;
      for (const r of routes.values()) r.gone?.(code ? `Antigravity stopped (${code}): ${said.trim().split('\n').pop() ?? ''}` : null);
    });
    me.ready = c.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ephemeris', title: 'Ephemeris', version: '1' } })
      .then((init) => { me.init = init; return me; }, (e) => { p.kill(); throw new Error(`Antigravity did not start: ${e.message}`); });
    return me.ready;
  }
  async function close() { const x = conn; conn = null; spare = null; x?.p.kill(); }
  // (its process stops once no conversation has used it for two minutes: it holds a third of a gigabyte)
  let idle = null;
  const rest = () => { clearTimeout(idle); idle = setTimeout(() => { if (conn && !conn.routes.size) close(); }, 120_000); idle.unref?.(); };
  const why = (e) => e?.data?.message ?? e?.message ?? String(e);
  const authed = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')).auth?.type ?? null; } catch { return null; } };

  // ---------- its models and thinking levels, as its sessions offer them
  const learn = (list) => { if (list?.length) options = list; };
  const opt = (cat) => options?.find((o) => o.category === cat);
  const flat = (o) => (o?.options ?? []).flatMap((x) => x.options ?? [x]);
  const model = () => settings().antigravityModel || opt('model')?.currentValue || '';
  const effort = () => settings().antigravityEffort || null;
  const servers = () => [{ name: 'ephemeris', command: mcp.command, args: mcp.args, env: Object.entries(mcp.env ?? {}).map(([name, value]) => ({ name, value })) }];
  // (its MCP tools as it finds them when needed: loaded up front, it names them as its own, and the panel could not tell
  // the studio's tools from others)
  const meta = () => ({ antigravity: { systemPrompt: { append: prompt() } } });
  // a session's model and thinking level as this machine chose them, and its mode (Auto Edit: files without asking)
  async function apply(c, id) {
    const set = async (o, value) => { if (o && value && o.currentValue !== value && flat(o).some((x) => x.value === value)) learn((await c.setSessionConfigOption({ sessionId: id, configId: o.id, value })).configOptions); };
    await set(opt('model'), settings().antigravityModel);
    await set(opt('thought_level'), effort());
    await c.setSessionMode({ sessionId: id, modeId: 'auto_edit' }).catch(() => {});
  }

  // ---------- a conversation
  function start({ resume = null, project: began = null }) {
    let done;
    const s = { id: resume, busy: false, named: !!resume, queue: [], turn: null, over: new Promise((r) => { done = r; }) };
    let c = null;
    function update(u) {
      const t = s.turn;
      if (!t) return;
      const flush = () => { if (t.text.trim()) emit({ type: 'text', text: t.text }); t.text = ''; };
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { t.text += u.content.text; emit({ type: 'delta', text: u.content.text }); }
      else if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && !u.toolCallId.startsWith(ASKS)) {
        flush();
        if (!t.seen.has(u.toolCallId) && (u.sessionUpdate === 'tool_call' || u.title || u.rawInput)) { t.seen.add(u.toolCallId); t.tools++; emit({ type: 'tool', id: u.toolCallId, ...shown(u) }); }
        if (u.status === 'completed' || u.status === 'failed') emit({ type: 'result', id: u.toolCallId, ok: u.status === 'completed', ...resultParts(blocks(u)) });
      } else if (u.sessionUpdate === 'usage_update' && u.cost?.currency === 'USD') s.cost = u.cost.amount;
    }
    // what it asks: a step (Allow, Always allow, Don't — the studio's own tools and looking answered here), or a
    // question with choices of its own
    async function permit({ toolCall, options: choices }) {
      const ids = choices.map((o) => o.optionId), pick = (optionId) => ({ outcome: { outcome: 'selected', optionId } });
      if (ids.every((i) => ['allow', 'deny', 'allow_always'].includes(i))) {
        const { name, input } = shown(toolCall);
        if (free(name)) return pick(ids.includes('allow_always') ? 'allow_always' : 'allow');
        const a = await ask(name, input, { always: ids.includes('allow_always'), signal: s.turn?.abort.signal });
        return pick(a.allow ? (a.always && ids.includes('allow_always') ? 'allow_always' : 'allow') : 'deny');
      }
      const a = await ask('question', { question: toolCall.title ?? '' }, { options: choices.map((o) => ({ id: o.optionId, name: o.name })), signal: s.turn?.abort.signal });
      return a.option ? pick(a.option) : { outcome: { outcome: 'cancelled' } };
    }
    const ready = (async () => {
      const x = await connect();
      c = x.c;
      let r;
      if (resume) r = await c.resumeSession({ sessionId: resume, cwd: root, mcpServers: servers(), _meta: meta() });
      else if (spare) { r = spare; spare = null; } else r = await c.newSession({ cwd: root, mcpServers: servers(), _meta: meta() });
      s.id = resume ?? r.sessionId;
      learn(r.configOptions);
      x.routes.set(s.id, { update, permit, gone: (msg) => { if (msg) emit({ type: 'error', text: msg }); finish({ stopReason: 'cancelled' }); done(); } });
      await apply(c, s.id);
      if (!resume) keep(s.id, { project: began ?? project(), at: Date.now(), root });
    })();
    ready.catch((e) => { emit({ type: 'error', text: why(e) }); done(); });

    function finish(r, err = null) {
      const t = s.turn;
      if (!t) return;
      if (t.text.trim()) emit({ type: 'text', text: t.text });
      s.turn = null; s.busy = false;
      keep(s.id, { at: Date.now() });
      if (err) emit({ type: 'error', text: err });
      emit({ type: 'done', ok: !err && r?.stopReason === 'end_turn', error: err ? 'failed' : r?.stopReason === 'cancelled' ? 'stopped' : r?.stopReason !== 'end_turn' ? r?.stopReason ?? 'failed' : null, cost: s.cost ?? null, turns: t.tools + 1, ms: Date.now() - t.t0 });
    }
    async function run(blocks) {
      await ready;
      // (named by its first message, and listed from here on, however soon the turn is cut short)
      if (!s.named && s.first) { keep(s.id, { title: title(s.first), at: Date.now() }); s.named = true; }
      s.turn = { t0: Date.now(), text: '', tools: 0, seen: new Set(), abort: new AbortController() };
      s.busy = true;
      emit({ type: 'session', id: s.id, model: flat(opt('model')).find((m) => m.value === opt('model')?.currentValue)?.name ?? model() });
      let r = null, err = null;
      try { r = await c.prompt({ sessionId: s.id, prompt: blocks }); } catch (e) { err = why(e); }
      finish(r, err);
      if (s.queue.length) run(s.queue.shift());
    }
    return Object.assign(s, {
      // the director's message ({ text, frame: { t, jpeg }, images: [{ type, data }] }); when, while it works: next and
      // later wait for its turn's end (ACP takes one message at a time), now stops it first
      send({ text, frame, images }, when) {
        const content = [{ type: 'text', text }];
        if (frame) content.push({ type: 'text', text: `(The frame on screen, ${frame.t.toFixed(2)} s:)` }, { type: 'image', data: frame.jpeg.toString('base64'), mimeType: 'image/jpeg' });
        if (images.length) content.push({ type: 'text', text: `(${images.length === 1 ? 'An image' : `${images.length} images`} the director attached:)` }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.type })));
        if (!s.turn && !s.queue.length) return void run(content).catch((e) => emit({ type: 'error', text: why(e) }));
        if (when === 'now') { s.queue.unshift(content); s.stop(); } else s.queue.push(content);
      },
      async stop() { s.turn?.abort.abort(); await ready.then(() => c.cancel({ sessionId: s.id })).catch(() => {}); },
      setPermissions: () => {},
      async end() {
        s.queue = [];
        await s.stop();
        conn?.routes.delete(s.id);
        await ready.then(() => c.closeSession?.({ sessionId: s.id })).catch(() => {});
        rest();
        done();
        return s.over;
      },
    });
  }

  return {
    id: 'antigravity', label: 'Antigravity', close,
    // (as the director asked: tried once with a Google sign-in, Google's terms unsettled for it)
    experimental: 'Highly experimental: tried with a Google sign-in (its free quota): a turn with the studio’s tools, a command asked first, the frame seen, a conversation continued. Of each tool’s result it passes back only a line of its own, and Google’s terms leave a personal account’s use here unsettled.',
    home: () => `Antigravity · ${HOME}`,
    model, effort,
    efforts: () => flat(opt('thought_level')).map((x) => x.value),
    // (no mode of its own judges a command: it asks)
    permissionModes: () => ['ask'],
    async models() {
      if (!options) {
        const { c } = await connect();
        spare = await c.newSession({ cwd: root, mcpServers: servers(), _meta: meta() }).catch((e) => { throw new Error(why(e)); });
        learn(spare.configOptions);
      }
      rest();
      return flat(opt('model')).map((x) => ({ value: x.value, name: x.name, description: x.description ?? '' }));
    },
    /** Whether Antigravity is ready here: installed (and whether the registry lists a newer one), signed in, as what;
     *  and what the settings can do about it. */
    async status() {
      const at = installed(), latest = await listed().catch(() => null);
      if (installing) return { ready: false, detail: installing.unpacking ? 'Unpacking…' : `Downloading… ${installing.total ? `${Math.round((100 * installing.done) / installing.total)}%` : `${Math.round(installing.done / 1e6)} MB`}`, installing: true };
      if (!at) return { ready: false, detail: latest ? `Not installed: Google’s Antigravity agent for ACP apps, ${latest.version}, about a gigabyte to download.` : 'Not installed (the ACP registry is not answering).', actions: latest ? [{ id: 'install', label: 'Install' }] : [] };
      const update = latest && latest.version.localeCompare(at.version, undefined, { numeric: true }) > 0 ? [{ id: 'install', label: `Update to ${latest.version}` }] : [];
      const init = await connect().then((x) => x.init, () => null);
      rest();
      const methods = (init?.authMethods ?? []).map((m) => ({ id: `auth:${m.id}`, label: m.name, ...(m.id === 'oauth-personal' ? { note: PERSONAL, caution: true } : { note: m.description }) }));
      const auth = authed();
      if (!auth) return { ready: false, detail: `Installed (${at.version}); not signed in.`, where: HOME, actions: [...methods, ...update] };
      return { ready: true, detail: `Signed in with ${SIGN_IN[auth] ?? auth} · ${at.version}`, where: HOME, actions: [...update, { id: 'logout', label: 'Sign out' }] };
    },
    /** What the settings asked of it: install (or update), sign in (auth:<method>), sign out. */
    async act(id) {
      if (id === 'install') return install();
      const { c } = await connect();
      rest();
      if (id === 'logout') { await c.logout({}); options = null; spare = null; return; }
      const m = /^auth:(.+)$/.exec(id)?.[1];
      if (m) { await c.authenticate({ methodId: m }).catch((e) => { throw new Error(why(e)); }); options = null; spare = null; }
    },
    async setModel(v, s) {
      setSettings({ antigravityModel: typeof v === 'string' && v ? v : null });
      if (s?.id && conn) await apply(conn.c, s.id).catch(() => {});
    },
    async setEffort(e, s) {
      setSettings({ antigravityEffort: typeof e === 'string' && e ? e : null });
      if (s?.id && conn) await apply(conn.c, s.id).catch(() => {});
    },
    start,
    async conversations() {
      return Object.entries(index()).filter(([, x]) => x.root === root && x.title).map(([id, x]) => ({ id, title: x.title, project: x.project || null, at: x.at, keeps: true }));
    },
    /** A session as the panel's events, as Antigravity replays it. */
    async transcript(id) {
      const x = await connect(), out = [];
      let you = null, text = '';
      const seen = new Set();
      const flush = () => {
        if (you) { const e = said(you.text, you.images); if (e) out.push(e); you = null; }
        if (text.trim()) out.push({ type: 'text', text }); text = '';
      };
      x.routes.set(id, {
        update(u) {
          if (u.sessionUpdate === 'user_message_chunk') {
            if (text.trim() || !you) { flush(); you = { text: '', images: [] }; }
            if (u.content?.type === 'text') you.text += (you.text ? '\n' : '') + u.content.text; else if (u.content?.type === 'image') you.images.push(u.content);
          } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { if (you) flush(); text += u.content.text; }
          else if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && !u.toolCallId.startsWith(ASKS)) {
            flush();
            if (!seen.has(u.toolCallId)) { seen.add(u.toolCallId); out.push({ type: 'tool', id: u.toolCallId, ...shown(u) }); }
            if (u.status === 'completed' || u.status === 'failed') out.push({ type: 'result', id: u.toolCallId, ok: u.status === 'completed', ...resultParts(blocks(u)) });
          }
        },
        permit: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      try { await x.c.loadSession({ sessionId: id, cwd: root, mcpServers: [] }); } catch (e) { throw new Error(why(e)); } finally { x.routes.delete(id); rest(); }
      flush();
      return out;
    },
    async rename(id, t) { keep(id, { title: title(t) }); },
    // (the panel forgets it; Antigravity keeps its transcript: its ACP server deletes no sessions)
    async remove(id) { keep(id, null); },
  };
}
