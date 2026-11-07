// The editor's end of the studio link (tools/link.mjs): one WebSocket carries every request the editor makes of its
// studio and every event stream it reads, in the app's own window and from another device alike, so none waits for one of
// the browser's six connections to the studio. link.fetch answers as fetch does (a Response); link.events is an
// EventSource. Requests elsewhere (another server's) go as fetch's. The link opens again a second after it drops: what was
// asked meanwhile fails as fetch does when the network does, and each event stream opens again ('open'). The studio asks
// the editor's own film over it too, what an agent asks of the film (offerFilm, onStudioAsk: tools/link.mjs).

const ws = { s: null, open: null, id: 0, asks: new Map(), streams: new Map(), events: new Set(), film: null, onAsk: null };   // (streams: by the id each is open under now; events: every one open)
const enc = new TextEncoder(), dec = new TextDecoder();
const linkUrl = () => { const u = new URL('/link', location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href; };

function frame(head, bytes) {
  const h = enc.encode(JSON.stringify(head)), out = new Uint8Array(4 + h.length + (bytes?.length ?? 0));
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  if (bytes?.length) out.set(bytes, 4 + h.length);
  return out;
}
function unframe(buf) {
  const n = new DataView(buf).getUint32(0, true);
  return [JSON.parse(dec.decode(new Uint8Array(buf, 4, n))), new Uint8Array(buf, 4 + n)];
}

function connect() {
  if (ws.open) return ws.open;
  ws.open = new Promise((resolve) => {
    const s = (ws.s = new WebSocket(linkUrl()));
    s.binaryType = 'arraybuffer';
    s.onopen = () => { resolve(s); for (const e of ws.events) e.start(); if (ws.film) s.send(frame({ film: ws.film })); };
    s.onmessage = ({ data }) => {
      const [head, bytes] = unframe(data), a = ws.asks.get(head.id);
      if (head.ask != null) return answer(s, head, bytes);
      if (a) return a.piece(head, bytes);
      ws.streams.get(head.id)?.piece(head, bytes);
    };
    s.onclose = () => {
      if (ws.s !== s) return;
      ws.s = null; ws.open = null;
      for (const a of ws.asks.values()) a.fail(new TypeError('The studio is not answering.'));
      ws.asks.clear();
      for (const e of ws.events) e.dropped();
      ws.streams.clear();
      setTimeout(connect, 1000)?.unref?.();   // (unref: where it runs in Node, a test's, it keeps nothing alive)
    };
  });
  return ws.open;
}

// the studio's question, answered by the editor's own film (onStudioAsk's answer, a Response), or not (503: the studio's own
// answers it)
async function answer(s, head, bytes) {
  let r = null;
  try { r = ws.onAsk && (await ws.onAsk(head.url, JSON.parse(dec.decode(bytes) || '{}'))); } catch { r = null; }
  const body = r ? new Uint8Array(await r.arrayBuffer()) : null;
  if (s.readyState === WebSocket.OPEN) s.send(frame({ answered: head.ask, status: r ? r.status : 503, headers: r ? Object.fromEntries(r.headers.entries()) : {} }, body));
}
/** The film this editor has up to answer the studio's questions with ({ key: 'name/timeline', ready }), or none. */
export function offerFilm(film) {
  ws.film = film;
  if (ws.s?.readyState === WebSocket.OPEN) ws.s.send(frame({ film }));
  else connect();
}
/** How the studio's questions about the film are answered here: fn(url, body), a promise of a Response, or null. */
export function onStudioAsk(fn) { ws.onAsk = fn; }

async function bodyBytes(body) {
  if (body == null) return null;
  if (typeof body === 'string') return enc.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return enc.encode(body.toString());
  return enc.encode(String(body));
}
const headersOf = (h) => (h instanceof Headers ? Object.fromEntries(h.entries()) : Array.isArray(h) ? Object.fromEntries(h) : { ...(h ?? {}) });

/** fetch, over the link for the studio's own requests. */
export async function linkFetch(input, init = {}) {
  const u = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (u.origin !== location.origin) return fetch(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = await bodyBytes(init.body ?? null), headers = headersOf(init.headers ?? (input instanceof Request ? input.headers : null));
  const s = await connect(), id = ++ws.id;
  return new Promise((resolve, reject) => {
    const parts = [];
    let head = null;
    ws.asks.set(id, {
      piece(h, bytes) {
        if (h.status != null) head = h;
        if (bytes.length) parts.push(bytes.slice());
        if (h.more) return;
        ws.asks.delete(id);
        resolve(new Response(parts.length ? new Blob(parts) : null, { status: head.status, headers: head.headers }));
      },
      fail: reject,
    });
    if (init.signal) init.signal.addEventListener('abort', () => { if (ws.asks.delete(id)) reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    s.send(frame({ id, method, url: u.pathname + u.search, headers }, body));
  });
}

/** An EventSource of the studio's, over the link: its events ('open' each time it is opened again, after the link drops). */
export class LinkEvents extends EventTarget {
  constructor(url) {
    super();
    const u = new URL(url, location.href);
    this.url = u.pathname + u.search;
    this.id = null; this.text = ''; this.closed = false;
    this.onopen = null; this.onerror = null;
    this.start = () => {
      if (this.closed || ws.s?.readyState !== WebSocket.OPEN) return;
      if (this.id != null) ws.streams.delete(this.id);
      this.id = ++ws.id; this.text = '';
      ws.streams.set(this.id, this);
      ws.s.send(frame({ id: this.id, method: 'GET', url: this.url, headers: { accept: 'text/event-stream' } }));
    };
    ws.events.add(this);
    if (ws.s?.readyState === WebSocket.OPEN) this.start(); else connect();
  }
  piece(head, bytes) {
    if (head.status != null) { const e = new Event('open'); this.onopen?.(e); this.dispatchEvent(e); }
    // (ended by the studio, as an EventSource's server ends one: opened again in a moment)
    if (head.more === false) { ws.streams.delete(this.id); this.id = null; this.dropped(); setTimeout(this.start, 1000)?.unref?.(); return; }
    this.text += dec.decode(bytes, { stream: true });
    let at;
    while ((at = this.text.indexOf('\n\n')) >= 0) {
      const block = this.text.slice(0, at);
      this.text = this.text.slice(at + 2);
      let type = 'message', data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':'), k = i < 0 ? line : line.slice(0, i), v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (k === 'event') type = v; else if (k === 'data') data.push(v);
      }
      if (data.length) { const e = new MessageEvent(type, { data: data.join('\n') }); if (type === 'message') this.onmessage?.(e); this.dispatchEvent(e); }
    }
  }
  dropped() { const e = new Event('error'); this.onerror?.(e); this.dispatchEvent(e); }
  close() {
    this.closed = true;
    ws.events.delete(this);
    if (this.id != null && ws.streams.delete(this.id) && ws.s?.readyState === WebSocket.OPEN) ws.s.send(frame({ id: this.id, cancel: true }));
  }
}
