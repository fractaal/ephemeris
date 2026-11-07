// What every harness of the studio's agent shares (tools/agent.mjs runs them): what the agent is told of the panel, the
// queue it reads the director's messages from, and the panel's words for what was said and done.

/** What the agent is told of where it is, as its instructions' end; name: what the director calls it. */
export const panelPrompt = (name, project) => `You are ${name}, the agent in the Ephemeris studio's panel, beside the director (the person you are talking to), who sees the studio: the viewer, the timeline with its cues and motion lanes, and the inspector.
Each message from the director starts with <studio>…</studio>: what the studio shows as they write (the open timeline, the playhead, what they have selected), often with the frame on screen attached. "This", "here" and "now" mean those.
Your project is projects/${project}. Your ephemeris MCP tools stay in this project when the director switches away; status names your selected timeline and open selects another timeline for this conversation only. A message’s <studio> context names the timeline the director is referring to; select it with open when it differs from your tool target. Other agents and the director share the live files: read current contents before editing and preserve changes you did not make. The ephemeris MCP tools see and change your selected timeline (status, frames, pick, locate, stacks, track, timeline, write_timeline, retime, reattach, media, check, reference, manual); use them to look before and after a change. track shows how the camera and things move on screen over a span, without rendering. reference says what an engine name is and how it is called: read it instead of grepping engine/. Film code is projects/<name>/film.js (edit it with your file tools; the studio re-renders what changed). Read the manual's motion chapter and the engine skill before writing film code. The director's cues and overrides are theirs: keep them unless asked; fold overrides into code only when asked.
When you need the director to decide something, ask in your reply: they answer in their next message.
Answer briefly and concretely; say what you changed and what to look at.`;

/** A queue a conversation reads the director's messages from, as they come (an async iterable). */
export function inbox() {
  const items = [];
  let wake = null, done = false;
  return {
    push(x) { items.push(x); wake?.(); },
    end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

/** A conversation's title: its first line, short. */
export const title = (t) => String(t).replace(/<studio>[\s\S]*?<\/studio>/g, '').trim().split('\n')[0].slice(0, 72) || 'A conversation';
/** A stored prompt or summary without the studio's preface. */
export const clean = (t) => (t ? String(t).replace(/<studio>[\s\S]*?<\/studio>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) : '');

/** A tool's input, short enough to show. */
export function brief(input) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) out[k] = typeof v === 'string' ? (v.length > 400 ? `${v.slice(0, 400)}…` : v) : JSON.stringify(v)?.length > 400 ? `${JSON.stringify(v).slice(0, 400)}…` : v;
  return out;
}

// an image block as a data URL: Anthropic's ({ source: { media_type, data } }) or Pi's ({ mimeType, data })
const dataUrl = (b) => (b?.source?.data ? `data:${b.source.media_type};base64,${b.source.data}` : b?.type === 'image' && b.data ? `data:${b.mimeType};base64,${b.data}` : null);
/** A tool's result as the panel shows it: its text (short) and its images (the frames it looked at). */
export function resultParts(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  return { text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 1600), images: parts.map(dataUrl).filter(Boolean).slice(0, 8) };
}

/** What the director said, as a stored message holds it (its text, and its blocks for the images), as the panel's event;
 *  null for none (only the studio's preface). Their chips are read back from the preface. */
export function said(text, blocks = []) {
  const pre = /<studio>([\s\S]*?)<\/studio>/.exec(text)?.[1] ?? '';
  const body = text.replace(/<studio>[\s\S]*?<\/studio>/, '').replace(/^\(The frame on screen[^\n]*\n?|^\((An image|\d+ images) the director attached[^\n]*\n?/gm, '').trim();
  if (!body) return null;
  const chips = [/Selected in the viewer: ([^,(]+)/.exec(pre)?.[1]?.trim(), /Selected in the timeline: ([^.]+)/.exec(pre)?.[1]?.split(' — ')[0], /Playhead: ([\d.]+ s)/.exec(pre)?.[1]].filter(Boolean);
  return { type: 'you', text: body, chips, images: blocks.map(dataUrl).filter(Boolean).slice(0, 6) };
}
