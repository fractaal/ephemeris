// The panel: the studio's agent beside the director (tools/agent.mjs runs the conversation in the studio, with Claude Code,
// Pi or Antigravity), called by the name this machine gives it. Each message carries what the studio shows as it is
// sent (the open timeline, the playhead, the selection, the frame on screen), as chips you can leave out. Replies
// stream in; each tool it uses is one line (the frames it looked at as thumbnails you can seek to). Ask first opens
// command approvals. Pi's Auto decides without a human prompt; Claude's native Auto can still ask.
import { glow } from './glow.js';
import { find } from './layout.js';
import { AGENT_NAME, agentShort } from './model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// an image of the conversation as the thread shows it: one the studio keeps (tools/agents/images.mjs: { image: its name }),
// as a thumbnail; one of yours not sent yet, as it is (a data URL)
const thumb = (x) => `<img src="${esc(typeof x === 'string' ? x : `${location.origin}/agent-image/${encodeURIComponent(x.image)}?w=240`)}" alt="" loading="lazy" decoding="async">`;
const SPARK = '<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.3 4.1 4.2-1.6-2.6 3.6 3.6 2.5-4.4.2.4 4.3L8 11.5l-2.5 3.1.4-4.3-4.4-.2 3.6-2.5L2.5 4l4.2 1.6z"/></svg>';

// a little Markdown: code blocks, inline code, bold, lists, paragraphs; film.js:12 becomes a link to the code
function md(s) {
  const blocks = String(s).split(/```[\w-]*\n?/);
  return blocks.map((b, i) => {
    if (i % 2) return `<pre>${esc(b.replace(/\n$/, ''))}</pre>`;
    return b.split(/\n{2,}/).map((p) => {
      const lines = p.split('\n'), list = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim());
      const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\b([\w./-]+\.(?:js|mjs|css|json|md)):(\d+)\b/g, '<button class="alink" data-file="$1" data-line="$2">$1:$2</button>');
      if (list) return `<ul>${lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
      return p.trim() ? `<p>${lines.map(inline).join('<br>')}</p>` : '';
    }).join('');
  }).join('');
}
/** A tool call as a line a person reads: [verb, what]. */
export function say(name, input = {}) {
  const m = /^mcp__ephemeris__(.+)$/.exec(name)?.[1], f = (p) => String(p ?? '').replace(/^.*\/(projects|engine|nle|tools|elements|docs)\//, '$1/');
  const bars = (b) => (b == null ? '' : ` · ${String(b).includes('-') ? 'bars' : 'bar'} ${b}`);
  // (the input as the agent sent it, which its tool may refuse: a list sent as JSON text, say)
  const list = (v) => (Array.isArray(v) ? v : []), keys = (v) => (v && typeof v === 'object' ? Object.keys(v) : []);
  if (m) return {
    status: ['Checked the studio', ''], projects: ['Listed the projects', ''], open: ['Open', input.project ?? ''], timeline: ['Read the timeline', ''],
    write_timeline: ['Wrote the timeline', input.message ?? ''], history: ['Read the timeline’s history', ''], frames: ['Looked at the project', `${input.times ?? ''} s`],
    view: ['Looked from another camera', `${input.t ?? ''} s`], camera: ['Read the camera’s path', ''], pick: ['Picked what is there', `${input.t ?? ''} s · ${input.x ?? ''}, ${input.y ?? ''}`],
    locate: ['Found it again', `${input.t ?? ''} s`], stacks: ['Read what its motion is made of', `${input.t ?? ''} s`], show: ['Showed you', input.note ?? input.property ?? (input.t != null ? `${input.t} s` : '')], check: ['Ran the checks', ''], render_draft: ['Rendered a draft', ''], manual: ['Read the manual', input.chapter ?? ''],
    notes: ['Read the notes', input.media ? `${input.media}${bars(input.bars)}` : ''], write_notes: ['Wrote notes', `${input.media ?? ''}${bars(input.bars)}`],
    mixer: input.set || input.add_buses?.length || input.remove_buses?.length ? ['Changed the mixer', [...keys(input.set), ...list(input.add_buses).map((b) => b?.name), ...list(input.remove_buses)].join(', ')] : ['Read the mixer', ''],
    instruments: [input.track ?? input.media ? 'Read the instrument' : 'Listed the instruments', input.track ?? input.media ?? input.query ?? ''], set_instrument: ['Changed the instrument', input.track ?? input.media ?? ''], audition: ['Auditioned an instrument', input.track ?? input.media ?? input.name ?? ''],
    levels: ['Measured the mix', ''], music: ['Read the music', ''], sounds: ['Measured sounds', ''], pitch: ['Read the notes in a recording', ''], bounce: ['Bounced the mix', ''],
  }[m] ?? [m, ''];
  if (name === 'Read') return ['Read', f(input.file_path)];
  if (name === 'Edit' || name === 'MultiEdit') return ['Edited', f(input.file_path)];
  if (name === 'Write') return ['Wrote', f(input.file_path)];
  if (name === 'Bash') return ['Ran', input.description || input.command];
  if (name === 'Grep') return ['Searched for', input.pattern];
  if (name === 'Glob') return ['Looked for files', input.pattern];
  if (name === 'TodoWrite') return ['Planned', ''];
  if (name === 'WebFetch' || name === 'WebSearch') return [name === 'WebFetch' ? 'Read the web' : 'Searched the web', input.url || input.query];
  if (name === 'Task' || name === 'Agent') return ['Asked a helper', input.description];
  return [name, ''];
}

/** What a tool the agent asks to use would do, as its ask says it ("… wants to run"): [verb, what]. */
function wants(name, input = {}) {
  const verb = { Bash: 'run', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', WebFetch: 'read', WebSearch: 'search the web for', Task: 'ask a helper', Agent: 'ask a helper', mcp__ephemeris__open: 'open' }[name];
  return [verb ?? `use ${name}`, say(name, input)[1]];
}

export function createAgentPanel(api) {
  const $ = find;   // (its panel may be in a window of its own)
  const el = $('#agent'), thread = $('#agentThread'), input = $('#agentInput'), chipsEl = $('#agentChips'), imgsEl = $('#agentImgs');
  let items = [], busy = false, model = '', off = new Set(), opened = false, stream = null, images = [], when = 'next', recent = [];
  let name = AGENT_NAME, harness = '', via = '';   // what the director calls it; what runs it (the studio says)
  let light = null;   // the composer's glow while the agent works (glow.js)
  const listEl = $('#agentList'), tabsEl = $('#agentTabs');
  const selectedKey = `nle:agent:${api.project}`;
  let agentId = '', agents = [], syncVersion = 0;
  try { agentId = localStorage.getItem(selectedKey) || ''; } catch {}
  const url = (p, id = agentId) => `${p}${p.includes('?') ? '&' : '?'}agent=${encodeURIComponent(id)}`;
  const get = (p) => api.get(url(p)), post = (p, b) => api.post(url(p), b);
  const draftKey = (id = agentId) => `${selectedKey}:${id}:draft`;
  function stash() { if (agentId) try { sessionStorage.setItem(draftKey(), JSON.stringify({ text: input.value, images, off: [...off] })); } catch {} }
  function restoreDraft() {
    let d = {}; try { d = JSON.parse(sessionStorage.getItem(draftKey()) || '{}'); } catch {}
    input.value = d.text ?? ''; images = d.images ?? []; off = new Set(d.off ?? []); tray(); chips();
  }
  function tabs(list = agents) {
    agents = list;
    tabsEl.innerHTML = agents.map((a, i) => `<button class="agent-tab${a.id === agentId ? ' on' : ''}${a.waiting ? ' waiting' : a.busy ? ' busy' : ''}" data-agent="${esc(a.id)}" aria-pressed="${a.id === agentId}" title="${esc(a.title)} · ${esc(a.timeline)}${a.waiting ? ' · Waiting for you' : a.busy ? ' · Working' : ''}"><i></i><span>${esc(a.title === 'New agent' ? `Agent ${i + 1}` : a.title)}</span>${a.waiting ? '<b>Waiting</b>' : ''}</button>`).join('');
    render();
  }
  async function choose(id) { stash(); agentId = id; restoreDraft(); listEl.hidden = true; await sync(); input.focus(); }
  tabsEl.onclick = (e) => { const b = e.target.closest('[data-agent]'); if (b && b.dataset.agent !== agentId) choose(b.dataset.agent); };
  input.addEventListener('input', stash);
  addEventListener('pagehide', stash);
  try { opened = localStorage.getItem('nle:agent') === '1'; } catch {}

  function show(on = !opened, focus = true) {
    opened = on; el.hidden = !on; $('#agentBtn').classList.toggle('on', on);
    try { localStorage.setItem('nle:agent', on ? '1' : '0'); } catch {}
    requestAnimationFrame(() => api.relayout());   // (on a page opening, the timeline is made after the panel)
    if (on) { chips(); if (focus) input.focus(); }
    render();
  }
  // ---------- the conversation, from the studio's events: each drawn once (by its n), as it comes, and the whole of it
  // caught up from the studio whenever the editor connects to it again (what it missed meanwhile: a step, a turn's end;
  // a studio started again, with none of it)
  let last = 0, heard = null, catching = false;   // the last event drawn; live ones heard while catching up
  function event(e) {
    if (heard) return heard.push(e);
    if (e.agent !== agentId) return;
    if (e.n <= last) return;
    apply(e); render();
  }
  async function sync() {
    const version = ++syncVersion;
    heard = [];
    try {
      let s = await get('api/agent');
      if (version !== syncVersion) return busy;
      if (s.error && agentId) { agentId = ''; s = await get('api/agent'); }
      if (version !== syncVersion) return busy;
      if (s.error) throw new Error(s.error);
      const changed = agentId !== s.id;
      agentId = s.id;
      try { localStorage.setItem(selectedKey, agentId); } catch {}
      if (changed) restoreDraft();
      tabs(s.agents ?? []);
      named(s.name); harness = s.harness; via = s.harnesses?.find((x) => x.id === s.harness)?.label ?? via;
      models(s.model); efforts(s.efforts, s.effort); perms(s); $('#agentState').title = s.home ?? '';
      items = []; limit = WINDOW; stream = null; last = 0; catching = true;
      for (const e of s.events) apply(e);
      busy = s.busy;
    } catch (e) { api.toast(e.message || 'The agent is not answering.', true); }
    finally {
      if (version === syncVersion) {
        catching = false;
        const h = heard; heard = null;
        for (const e of h ?? []) if (e.agent === agentId && e.n > last) apply(e);
        loadRecent(); render();
      }
    }
    return busy;
  }
  const waiting = () => busy && items.some((x) => x.kind === 'ask' && x.state === 'waiting');   // (for your answer)
  let asked = null;   // an ask just come: brought into view and lit
  function apply(e) {
    if (e.n) last = e.n;
    switch (e.type) {
      case 'session': model = e.model; busy = true; break;   // (a turn begun)
      case 'you': items.push({ kind: 'you', text: e.text, chips: e.chips, frame: e.frame, images: e.images, when: busy ? e.when : null }); busy = true; stream = null; break;
      case 'delta': if (!stream) items.push((stream = { kind: 'text', text: '' })); stream.text += e.text; touch(stream); break;
      case 'text': if (stream) { stream.text = e.text; touch(stream); stream = null; } else items.push({ kind: 'text', text: e.text }); break;
      case 'tool': stream = null; items.push({ kind: 'tool', id: e.id, name: e.name, input: e.input, timeline: e.timeline, state: 'running' }); break;
      case 'result': { const t = items.findLast((x) => x.kind === 'tool' && x.id === e.id); if (t) touch(Object.assign(t, { state: e.ok ? 'ok' : 'error', text: e.text, images: e.images })); break; }
      case 'ask': stream = null; items.push({ kind: 'ask', id: e.id, name: e.name, input: e.input, always: e.always, options: e.options, state: 'waiting' }); if (!catching) asked = e.id; break;
      case 'answered': { const a = items.findLast((x) => x.kind === 'ask' && x.id === e.id); if (a) { a.state = e.automatic ? 'automatic' : e.allow ? (e.always ? 'always' : 'allowed') : 'denied'; a.chose = e.option; touch(a); } break; }
      case 'done': busy = false; stream = null; if (!catching) loadRecent(); for (const t of items) if (t.state === 'running') { t.state = 'ok'; touch(t); } items.push({ kind: 'done', ok: e.ok, error: e.error, cost: e.cost, turns: e.turns, ms: e.ms }); break;
      case 'error': busy = false; items.push({ kind: 'error', text: e.text }); break;
      case 'ended': busy = false; stream = null; break;
      case 'reset': items = []; limit = WINDOW; busy = false; stream = null; if (!catching) loadRecent(); break;
      case 'resumed': items.push({ kind: 'resumed', title: e.title, project: e.project, via: e.via }); break;
      case 'studio': items.push({ kind: 'studio', text: e.text }); break;
    }
  }
  // ---------- the thread, as it changes: each item drawn once, and again only when it changes (touch), the latest WINDOW of
  // them (Show earlier draws more). The whole thread drawn again on each event costs a long conversation (409 events, 136
  // images) 107 to 161 ms of the editor's thread a frame while the agent writes; this, 3 to 6 ms
  const WINDOW = 150;
  let limit = WINDOW;
  const nodes = new Map();   // (item → its element and the version of it drawn)
  function touch(x) { x.v = (x.v ?? 0) + 1; return x; }
  function paint() {
    const doc = thread.ownerDocument;
    if (!items.length) {
      nodes.clear();
      thread.dataset.mode = 'empty';
      thread.innerHTML = `<div class="aempty">${SPARK}<b>${esc(name)}</b><span>Ask about what you see, or describe a change. It sees your selection, the playhead and the frame.</span><span class="avia">${esc(via)}</span>${recent.length ? `<div class="arecent"><span class="sec">Continue a conversation</span>${recent.slice(0, 5).map(convRow).join('')}<button class="link" data-al="all">All conversations…</button></div>` : ''}</div>`;
      return;
    }
    if (thread.dataset.mode !== 'items') { thread.dataset.mode = 'items'; thread.textContent = ''; nodes.clear(); }
    const from = Math.max(0, items.length - limit), shown = items.slice(from), keep = new Set(shown);
    for (const [it, n] of nodes) if (!keep.has(it)) { n.el.remove(); nodes.delete(it); }
    let earlier = thread.querySelector(':scope > .aearlier');
    if (from > 0) {
      if (!earlier) { earlier = doc.createElement('button'); earlier.className = 'link aearlier'; thread.prepend(earlier); }
      const label = `Show earlier (${from})`;
      if (earlier.textContent !== label) earlier.textContent = label;
    } else earlier?.remove();
    let prev = from > 0 ? earlier : null;
    for (const it of shown) {
      let n = nodes.get(it);
      if (!n || n.v !== (it.v ?? 0)) {
        const el = n?.el ?? doc.createElement('div');
        el.className = 'aitem';
        el.innerHTML = item(it);
        nodes.set(it, (n = { el, v: it.v ?? 0 }));
      }
      const at = prev ? prev.nextSibling : thread.firstChild;
      if (n.el !== at) thread.insertBefore(n.el, at);
      prev = n.el;
    }
  }
  // (what the items show besides themselves changed: all drawn again)
  const redraw = () => { nodes.clear(); thread.dataset.mode = ''; render(); };
  let pending = false;
  function render() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
      paint();
      if (atEnd) thread.scrollTop = thread.scrollHeight;
      $('#agentStop').hidden = !busy;
      $('#agentWhen').hidden = !busy;
      const verb = busy ? { next: 'Send it after this step', later: `Queue it for when ${name} is done`, now: 'Steer: send it now' }[when] : 'Send';
      $('#agentSend').title = `${verb} (Enter · Shift+Enter: a new line)`; $('#agentSend').setAttribute('aria-label', verb);
      $('#agentSend').disabled = false;
      // waiting for your answer is not working: the header says so, and the question is lit in place of the composer
      const wait = waiting();
      $('#agentState').textContent = wait ? 'waiting for you' : 'working…'; $('#agentState').hidden = !busy;
      if (model) $('#agentModel').title = `Model: ${model}`;
      $('#agentBtn').classList.toggle('busy', agents.some((a) => a.busy && !a.waiting)); $('#agentBtn').classList.toggle('waiting', agents.some((a) => a.waiting));
      const lit = busy && !wait && opened;
      if (lit && !light) light = glow(() => input.getBoundingClientRect(), { mode: 'spin', radius: 4, el: input });
      if (!lit && light) { light.stop(); light = null; }
      if (asked) {
        const id = asked, card = () => thread.querySelector(`[data-ask="${id}"]`);
        asked = null;
        if (opened && card()) { card().scrollIntoView({ block: 'nearest' }); glow(() => card()?.getBoundingClientRect() ?? null, { mode: 'pulse', radius: 5, el: thread }); }
      }
    });
  }
  function item(x) {
    if (x.kind === 'you') return `<div class="amsg you">${x.chips?.length || x.when ? `<div class="achips">${x.when ? `<span class="awhentag">${{ next: 'after its step', later: 'when done', now: 'now' }[x.when]}</span>` : ''}${(x.chips ?? []).map((c) => `<span class="achip">${esc(c)}</span>`).join('')}</div>` : ''}${x.images?.length ? `<div class="athumbs">${x.images.map((img) => `<span class="athumb">${thumb(img)}</span>`).join('')}</div>` : ''}<p>${esc(x.text).replace(/\n/g, '<br>')}</p></div>`;
    if (x.kind === 'text') return `<div class="amsg claude">${md(x.text)}</div>`;
    if (x.kind === 'tool') {
      const [verb, what] = say(x.name, x.input);
      const imgs = (x.images ?? []).map((img, i) => { const t = (x.text ?? '').split('\n').filter((l) => / s · frame /.test(l))[i]; return `<button class="athumb" data-timeline="${esc(x.timeline ?? '')}" data-seek="${t ? parseFloat(t) : ''}" title="${esc(t ?? '')}">${thumb(img)}</button>`; }).join('');
      let pick = '';
      if (/__(pick|locate)$/.test(x.name) && x.state === 'ok') { try { const r = JSON.parse(x.text); if (r?.at) pick = `<button class="alink" data-select='${esc(JSON.stringify({ t: +(x.input.t ?? 0), at: r.at, nth: r.nth, key: r.key, like: r.like, copy: r.copy }))}'>${esc(r.label || r.kind)}</button>`; } catch {} }
      return `<div class="atool ${x.state}"><span class="aic"></span><b>${esc(verb)}</b><span class="awhat">${esc(what)}</span>${pick}${x.state === 'error' ? `<span class="aerr" title="${esc(x.text)}">failed</span>` : ''}</div>${imgs ? `<div class="athumbs">${imgs}</div>` : ''}`;
    }
    // (a question of its own, with its choices)
    if (x.kind === 'ask' && x.options) {
      return `<div class="aask ${x.state}" data-ask="${x.id}"><div class="ahead">${SPARK}<b>${esc(name)} asks</b></div><p class="aq">${esc(x.input?.question ?? '')}</p>
        ${x.state === 'waiting' ? `<div class="arow">${x.options.map((o, i) => `<button class="btn${i ? '' : ' primary'}" data-answer="${x.id}" data-option="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>` : `<span class="aanswer">${esc(x.options.find((o) => o.id === x.chose)?.name ?? 'Not answered')}</span>`}</div>`;
    }
    if (x.kind === 'ask') {
      const [verb, what] = wants(x.name, x.input), cmd = x.input?.command;
      return `<div class="aask ${x.state}" data-ask="${x.id}"><div class="ahead">${SPARK}<b>${esc(name)} wants to ${esc(verb)}</b></div>${cmd ? `<pre>${esc(cmd)}</pre>` : `<span class="awhat">${esc(what || JSON.stringify(x.input))}</span>`}
        ${x.state === 'waiting' ? `<div class="arow"><button class="btn primary" data-answer="${x.id}" data-allow="1">Allow</button>${x.always ? `<button class="btn" data-answer="${x.id}" data-allow="1" data-always="1">Always allow (this conversation)</button>` : ''}<button class="btn ghost" data-answer="${x.id}">Don’t</button></div>` : `<span class="aanswer">${{ allowed: 'Allowed', always: 'Allowed for this conversation', denied: 'Not allowed', automatic: 'Permission mode changed' }[x.state]}</span>`}</div>`;
    }
    if (x.kind === 'resumed') return `<div class="aresumed">${SPARK}<span>Continuing <b>${esc(x.title)}</b>${x.project ? ` · ${esc(x.project)}` : ''}${x.via ? ` · ${esc(x.via)}` : ''}: your next message picks it up</span></div>`;
    if (x.kind === 'done') return `<div class="adone">${x.ok ? '' : `<span class="aerr">${x.error === 'error_during_execution' ? 'stopped' : esc(x.error ?? 'stopped')}</span> · `}${x.turns ?? 0} step${x.turns === 1 ? '' : 's'} · ${((x.ms ?? 0) / 1000).toFixed(0)} s${x.cost ? ` · $${x.cost.toFixed(2)} so far` : ''}</div>`;
    if (x.kind === 'error') return `<div class="aerror">${esc(x.text)}</div>`;
    if (x.kind === 'studio') return `<div class="astudio"><b>Studio</b><span>${esc(x.text)}</span></div>`;
    return '';
  }

  // ---------- conversations: the panel's past ones (each harness keeps its own), to continue, rename or delete
  const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  const convRow = (c, full = false) => `<div class="alrow${c.current ? ' cur' : ''}" data-al="resume" data-id="${c.id}" data-harness="${c.harness}" title="Continue this conversation (with ${esc(c.via)})"><span class="alt">${esc(c.title)}</span><span class="alm">${c.project ? `${esc(c.project)} · ` : ''}${esc(c.via)} · ${ago(c.at)}</span>${full ? `<button data-al="rename" data-id="${c.id}" data-harness="${c.harness}" title="Rename" aria-label="Rename">✎</button><button data-al="delete" data-id="${c.id}" data-harness="${c.harness}" data-via="${esc(c.via)}"${c.keeps ? ' data-keeps="1"' : ''} title="Delete" aria-label="Delete">×</button>` : ''}</div>`;
  async function loadRecent() { const id = agentId, list = await get('api/agent/conversations').catch(() => []); if (id !== agentId) return; recent = Array.isArray(list) ? list : []; if (!items.length) render(); }
  async function openList() {
    const list = await get('api/agent/conversations').then((r) => Array.isArray(r) ? r : []).catch(() => []);
    listEl.hidden = false;
    listEl.innerHTML = `<div class="alhead"><b>Conversations</b><span class="alm">${list.length}</span><span class="grow"></span><button data-al="close" aria-label="Close">×</button></div><div class="albody">${list.length ? list.map((c) => convRow(c, true)).join('') : '<div class="alempty">No conversations yet: your first message starts one.</div>'}</div>`;
  }
  async function onList(e) {
    const b = e.target.closest('[data-al]');
    if (!b) return;
    e.stopPropagation();
    const id = b.dataset.id, h = b.dataset.harness;
    if (b.dataset.al === 'close') { listEl.hidden = true; return; }
    if (b.dataset.al === 'all') return openList();
    if (b.dataset.al === 'resume') {
      listEl.hidden = true;
      const r = await post('api/agent/resume', { id, harness: h }).then((x) => x.json()).catch((x) => ({ error: x.message }));
      if (r.error) api.toast(r.error, true); else await choose(r.id);
      return;
    }
    if (b.dataset.al === 'rename') {
      const row = b.closest('.alrow'), t = row.querySelector('.alt'), was = t.textContent;
      t.innerHTML = `<input value="${esc(was)}" aria-label="Title">`;
      const i = t.querySelector('input');
      i.focus(); i.select();
      i.onclick = (x) => x.stopPropagation();
      const done = async (keep) => { const v = i.value.trim(); if (keep && v && v !== was) await post('api/agent/rename', { id, harness: h, title: v }); openList(); loadRecent(); };
      i.onkeydown = (x) => { x.stopPropagation(); if (x.key === 'Enter') done(true); if (x.key === 'Escape') done(false); };
      i.onblur = () => done(true);
      return;
    }
    if (b.dataset.al === 'delete') {
      if (!confirm(`Delete “${b.closest('.alrow').querySelector('.alt').textContent}”? ${b.dataset.keeps ? `${b.dataset.via} keeps its transcript: the panel forgets it.` : 'Its transcript goes too.'}`)) return;
      await post('api/agent/delete', { id, harness: h });
      openList(); loadRecent();
    }
  }
  listEl.addEventListener('click', onList);
  thread.addEventListener('click', (e) => { if (e.target.closest('.arecent')) onList(e); });
  $('#agentConvs').onclick = () => (listEl.hidden ? openList() : (listEl.hidden = true));

  // ---------- what goes with a message: the studio as it is now (each part a chip you can leave out)
  function context() {
    const c = api.context(), list = [];
    if (c.sel) list.push(['sel', `${c.sel.sites ? `${c.sel.object || c.sel.label || c.sel.kind}, every copy` : c.sel.label || c.sel.kind}${c.also?.length ? ` and ${c.also.length} more` : ''}`]);
    if (c.lane) list.push(['lane', c.lane.split(' — ')[0]]);
    if (c.cues?.length) list.push(['cues', c.cues.length === 1 ? `cue ${c.cues[0]}` : `${c.cues.length} cues`]);
    if (c.clips?.length) list.push(['clips', c.clips.length === 1 ? `clip ${c.clips[0].split(' on ')[0]}` : `${c.clips.length} clips`]);
    if (c.notes) list.push(['notes', `${c.noteCount} note${c.noteCount === 1 ? '' : 's'}`]);
    if (c.code) list.push(['code', c.code]);
    list.push(['t', `${c.t.toFixed(2)} s`]);
    if (c.frameReady) list.push(['frame', 'the frame']);
    return { c, list };
  }
  function chips() {
    if (!opened) return;
    const { list } = context(), html = list.map(([k, label]) => `<span class="achip${off.has(k) ? ' off' : ''}">${esc(label)}<button data-chip="${k}" aria-label="${off.has(k) ? 'Include' : 'Leave out'} ${esc(label)}">${off.has(k) ? '+' : '×'}</button></span>`).join('');
    if (chipsEl.innerHTML !== html) chipsEl.innerHTML = html;
  }
  async function send(text = input.value) {
    text = text.trim();
    if (!text) return input.focus();
    const { c, list } = context(), keep = list.filter(([k]) => !off.has(k));
    const ctx = { t: c.t, frame: c.frame, chips: keep.map(([, l]) => l), ...(!off.has('sel') && c.sel && { sel: c.sel, ...(c.also?.length && { also: c.also }) }), ...(!off.has('lane') && c.lane && { lane: c.lane }), ...(!off.has('cues') && c.cues?.length && { cues: c.cues }), ...(!off.has('clips') && c.clips?.length && { clips: c.clips }), ...(!off.has('notes') && c.notes && { notes: c.notes }), ...(!off.has('code') && c.code && { code: c.code }), ...(c.range && { range: c.range }) };
    const imgs = images, sentBy = agentId;
    input.value = ''; images = []; tray(); stash();
    $('#agentSend').disabled = true;
    const r = await post('api/agent/send', { text, context: ctx, frame: !off.has('frame') && c.frameReady, images: imgs, when: busy ? when : 'next' }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    $('#agentSend').disabled = false;
    if (r.error) { api.toast(`${name}: ${r.error}`, true); if (agentId === sentBy) { input.value = text; images = imgs; tray(); stash(); } else try { sessionStorage.setItem(draftKey(sentBy), JSON.stringify({ text, images: imgs })); } catch {} }
    when = 'next'; for (const b of $('#agentWhen').querySelectorAll('button')) b.classList.toggle('on', b.dataset.when === when);
  }

  // ---------- images of your own: pasted, dropped, attached (shrunk to at most 1600 px, as JPEG)
  function tray() {
    imgsEl.hidden = !images.length;
    imgsEl.innerHTML = images.map((src, i) => `<span class="athumb"><img src="${src}" alt=""><button data-unimg="${i}" aria-label="Remove">×</button></span>`).join('');
  }
  async function addImages(files) {
    const id = agentId, added = [];
    for (const f of [...files].filter((x) => x.type.startsWith('image/')).slice(0, 6 - images.length)) {
      const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      added.push(c.toDataURL('image/jpeg', 0.88));
      bmp.close();
    }
    if (id !== agentId) {
      try { const d = JSON.parse(sessionStorage.getItem(draftKey(id)) || '{}'); d.images = [...(d.images ?? []), ...added]; sessionStorage.setItem(draftKey(id), JSON.stringify(d)); } catch {}
      return;
    }
    images.push(...added); tray(); stash(); input.focus();
  }
  input.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); addImages(fs); } });
  const comp = $('#agentComposer');
  comp.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); e.stopPropagation(); comp.classList.add('drop'); } });
  comp.addEventListener('dragleave', () => comp.classList.remove('drop'));
  comp.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); e.stopPropagation(); comp.classList.remove('drop'); addImages(e.dataTransfer.files); });
  $('#agentAttach').onclick = () => $('#agentFile').click();
  $('#agentFile').onchange = (e) => { addImages(e.target.files); e.target.value = ''; };
  imgsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-unimg]'); if (b) { images.splice(+b.dataset.unimg, 1); tray(); } });
  // while the agent works: when your message reaches it
  $('#agentWhen').onclick = (e) => { const b = e.target.closest('[data-when]'); if (!b) return; when = b.dataset.when; for (const x of $('#agentWhen').querySelectorAll('button')) x.classList.toggle('on', x === b); render(); input.focus(); };

  // ---------- events
  $('#agentBtn').onclick = () => show();
  $('#agentNew').onclick = async () => {
    const r = await post('api/agent/new', {}).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) api.toast(r.error, true); else await choose(r.id);
  };
  $('#agentEnd').onclick = async () => {
    if (busy && !confirm('End this agent? Its current work stops; its conversation is kept.')) return;
    const r = await post('api/agent/close', {}).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) api.toast(r.error, true); else await choose('');
  };
  $('#agentStop').onclick = () => post('api/agent/stop', {});
  $('#agentSend').onclick = () => send();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && busy) { e.preventDefault(); post('api/agent/stop', {}); }
    e.stopPropagation();
  });
  chipsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (!b) return; const k = b.dataset.chip; if (off.has(k)) off.delete(k); else off.add(k); chips(); });
  thread.addEventListener('click', (e) => {
    if (e.target.closest('.aearlier')) { const h = thread.scrollHeight; limit += WINDOW; paint(); thread.scrollTop += thread.scrollHeight - h; return; }
    const a = e.target.closest('[data-answer]');
    if (a) return post('api/agent/answer', { id: a.dataset.answer, allow: !!a.dataset.allow, always: !!a.dataset.always, ...(a.dataset.option && { option: a.dataset.option }) });
    const l = e.target.closest('.alink');
    if (l) return api.showCode({ file: l.dataset.file, line: +l.dataset.line });
    const th = e.target.closest('[data-seek]');
    if (th && th.dataset.seek !== '') { if (th.dataset.timeline && th.dataset.timeline !== api.timeline) api.openTimeline(th.dataset.timeline); else api.seek(+th.dataset.seek); }
    const sel = e.target.closest('[data-select]');
    if (sel) api.select(JSON.parse(sel.dataset.select));
  });

  // what the director calls it: the panel, its button and the studio's words for it (named in the settings)
  function named(n) {
    if (!n || n === name) return;
    name = n;
    for (const x of document.querySelectorAll('.agent-name')) x.textContent = n;
    for (const x of document.querySelectorAll('.agent-short')) x.textContent = agentShort(n);
    for (const x of el.ownerDocument === document ? [] : el.ownerDocument.querySelectorAll('.agent-name')) x.textContent = n;
    el.setAttribute('aria-label', n);
    input.placeholder = `Ask ${agentShort(n)}, or describe a change…`;
    $('#agentBtn').title = `Ask ${agentShort(n)}, or describe a change (L)`;
    api.renamed?.(n);
    redraw();
  }
  // which model, of each harness (as each lists them: asked of the studio once, the one chosen shown until they come); one
  // of another harness changes harness (the conversation going on ends)
  const opt = (h, v, n, title = '') => `<option data-h="${esc(h)}" value="${esc(v)}" title="${esc(title)}">${esc(n)}</option>`;
  let chosen = '';   // (the model the studio has, of the harness the panel shows)
  async function models(m) {
    const sel = $('#agentModel');
    chosen = m;
    sel.innerHTML = opt(harness, chosen, chosen || 'Model'); sel.value = chosen;
    const id = agentId, groups = await get('api/agent/models').catch(() => []);
    if (id !== agentId || !groups.length) return;
    sel.innerHTML = groups.map((g) => `<optgroup label="${esc(g.label)}${g.experimental ? ' · highly experimental' : ''}" data-label="${esc(g.label)}">${g.harness === harness && !g.models.some((m) => m.value === chosen) && chosen ? opt(g.harness, chosen, chosen) : ''}${g.models.length ? g.models.map((m) => opt(g.harness, m.value, m.name, m.description)).join('') : `<option disabled title="${esc(g.error ?? '')}">${g.error ? 'Not set up: see Settings' : 'No models'}</option>`}</optgroup>`).join('') + '<option value="" data-settings>Agent settings…</option>';
    pick(chosen);
  }
  const pick = (v) => { const sel = $('#agentModel'); for (const o of sel.options) if (o.dataset.h === harness && o.value === v) { o.selected = true; return; } };
  $('#agentModel').onchange = async (e) => {
    const o = e.target.selectedOptions[0];
    if (o?.dataset.settings != null) { pick(chosen); return api.settings?.(); }
    const h = o?.dataset.h ?? harness, label = o?.closest('optgroup')?.dataset.label ?? h;
    if (h !== harness && items.length && !confirm(`Switch to ${label}? This conversation ends (${via} keeps its transcript); your next message starts one with ${label}.`)) { pick(chosen); return; }
    const id = agentId;
    const r = await post('api/agent/model', { model: e.target.value, harness: h }).then((x) => x.json()).catch((x) => ({ error: x.message }));
    if (id !== agentId) return;
    if (r.error) { api.toast(`${name}: ${r.error}`, true); pick(chosen); return; }
    const changed = r.harness !== harness;
    harness = r.harness; via = label; chosen = r.model; efforts(r.efforts, r.effort); perms(r); $('#agentState').title = r.home ?? '';
    pick(chosen);
    if (changed) { render(); loadRecent(); }
  };
  // how hard it thinks (a level of those its model has, or its own), this conversation too
  const LEVEL = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', extra_high: 'extra high', max: 'max' };
  function efforts(list = [], chosen = null) {
    const sel = $('#agentEffort');
    sel.innerHTML = `<option value="">Effort · default</option>${list.map((l) => `<option value="${esc(l)}">Effort · ${esc(LEVEL[l] ?? l)}</option>`).join('')}`;
    sel.value = list.includes(chosen) ? chosen : '';
  }
  $('#agentEffort').onchange = async (e) => {
    const id = agentId;
    const r = await post('api/agent/effort', { effort: e.target.value || null }).then((x) => x.json()).catch((x) => ({ error: x.message }));
    if (id !== agentId) return;
    if (r.error) api.toast(`${name}: ${r.error}`, true); else e.target.value = r.effort ?? '';
  };
  // How it may act: only the modes its harness supports, this conversation too.
  function perms({ permissionModes = ['auto', 'ask'], permissions = 'auto' }) {
    const sel = $('#agentPerm');
    const labels = { auto: harness === 'pi' ? 'Auto (no prompts)' : 'Auto (may ask)', ask: 'Ask first', bypass: 'Bypass permissions (DANGER)' };
    sel.innerHTML = permissionModes.map((m) => `<option value="${m}">${labels[m]}</option>`).join('');
    sel.value = permissions;
    sel.title = permissionModes.includes('bypass')
      ? { auto: 'Ephemeris allows or denies commands without asking you.', ask: 'Asks before commands that need permission.', bypass: 'DANGER: Runs commands without security evaluation, including outside your project.' }[permissions]
      : permissionModes.includes('auto') ? `Auto: ${name} asks you only when it is unsure. Ask first: Claude Code asks before commands it does not already permit. It edits files without asking.`
      : `${via} asks before commands. It edits files without asking.`;
  }
  $('#agentPerm').onchange = async (e) => {
    const id = agentId;
    const r = await post('api/agent/permissions', { permissions: e.target.value }).then((x) => x.json()).catch((x) => ({ error: x.message }));
    if (id !== agentId) return;
    if (r.error) api.toast(`${name}: ${r.error}`, true); else perms(r);
  };
  restoreDraft();
  if (opened) show(true, !api.simple); else el.hidden = true;   // (a phone's keyboard would cover the viewer)
  render();
  return {
    /** sync: the conversation so far, from the studio (an editor opened in the middle of one; connected again): whether
     *  the agent is working. */
    event, sync, chips, show, stash, agents: tabs,
    get id() { return agentId; },
    /** What the director calls it (the settings name it); whether a conversation is shown (one another harness would end). */
    get name() { return name; },
    get short() { return agentShort(name); },
    get talking() { return items.length > 0; },
    named,
    /** Opens the panel with `text` in the box (to send as is, or change first); send: at once. */
    ask(text = '', now = false) { show(true); if (now) send(text); else if (text) { input.value = text; input.focus(); input.setSelectionRange(text.length, text.length); } },
    get opened() { return opened; },
  };
}
