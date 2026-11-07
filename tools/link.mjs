// The studio link: how an editor reaches its studio. One WebSocket carries every request it makes and every event
// stream it reads, in the app's own window and from another device alike (nle/link.js is the editor's end). Over HTTP,
// each request held one of the browser's six connections to the studio, and an event stream held one for good, so a
// few slow ones (a lanes sweep, the objects) left a click waiting for a connection, seconds at a time.
//
// A message is a header and maybe bytes: [u32 LE: the header's length][the header, JSON][bytes].
//   editor → studio: { id, method, url, headers } with the request's body as its bytes; { id, cancel: true } (an event
//   stream the editor closed)
//   studio → editor: { id, status, headers, more } with the body's first piece; { id, more } with each piece after it
//   (more false on the last). An event stream's pieces come as they are written, until it is cancelled.
// And the other way, the studio asking the editor's own film what an agent asks of the film (link.ask):
//   editor → studio: { film: { key: 'name/timeline', ready } } (the film it has up, answering, or not); { answered, status }
//   with the answer as its bytes
//   studio → editor: { ask, url, body } (the question as the studio's route for it takes it: url 'api/pick', its body)
// The studio's own HTTP handler answers each, as it would the same request over HTTP from where the link came from.
import { Readable, Writable } from 'node:stream';

// (a body goes a piece at a time, in turn with every other answer's pieces: a sound file being read never holds up the
// answer to a click)
const PIECE = 256 * 1024;

/** A message of the link: its header and bytes. */
export function frame(head, bytes = null) {
  const h = Buffer.from(JSON.stringify(head)), n = Buffer.alloc(4);
  n.writeUInt32LE(h.length);
  return bytes?.length ? Buffer.concat([n, h, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]) : Buffer.concat([n, h]);
}
/** [header, bytes] of a message of the link. */
export function unframe(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data), n = buf.readUInt32LE(0);
  return [JSON.parse(buf.toString('utf8', 4, 4 + n)), buf.subarray(4 + n)];
}

/**
 * Serves an editor's link: ws, its WebSocket; from, the request it came with (where it came from, its credentials: each
 * request over it is taken to come from there); handle(req, res), the studio's HTTP handler; film(link, { key, ready } |
 * null), what film the editor has up to answer (null: the link gone). The link: ask(url, body, ms), a promise of the
 * editor's answer, { status, headers, body }.
 */
export function serveLink(ws, from, handle, { film = () => {} } = {}) {
  const streams = new Map();   // (event streams going on: id → their request, told 'close' when they end)
  const asked = new Map();   // (the studio's questions to the editor: id → their promise's ends)
  let askId = 0;
  const link = {
    ask(url, body, ms = 60_000) {
      if (ws.readyState !== ws.OPEN) return Promise.reject(new Error('the editor is gone'));
      const id = ++askId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { asked.delete(id); reject(new Error('the editor did not answer')); }, ms);
        asked.set(id, { resolve: (a) => { clearTimeout(timer); resolve(a); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        send({ ask: id, url }, Buffer.from(JSON.stringify(body ?? {})));
      });
    },
  };
  const answers = [];   // (answers with pieces left to send, each in turn)
  let sending = false;
  const send = (head, bytes) => new Promise((resolve) => { if (ws.readyState !== ws.OPEN) return resolve(); ws.send(frame(head, bytes), () => resolve()); });
  async function pump() {
    if (sending) return;
    sending = true;
    while (answers.length && ws.readyState === ws.OPEN) {
      const a = answers.shift(), piece = a.body.subarray(a.at, a.at + PIECE);
      a.at += piece.length;
      const more = a.at < a.body.length;
      await send(a.at === piece.length ? { id: a.id, status: a.status, headers: a.headers, more } : { id: a.id, more }, piece);
      if (more) answers.push(a);
    }
    sending = false;
  }
  ws.on('message', (data) => {
    let head, body;
    try { [head, body] = unframe(data); } catch { return; }
    if (head.cancel) { streams.get(head.id)?.emit('close'); streams.delete(head.id); return; }
    if (head.film !== undefined) return film(link, head.film && { key: String(head.film.key), ready: !!head.film.ready });
    if (head.answered != null) { const a = asked.get(head.answered); asked.delete(head.answered); a?.resolve({ status: head.status ?? 500, headers: head.headers ?? {}, body: Buffer.from(body) }); return; }
    // (its body read as a request's is; it closes only when the editor ends it, as a request does when its connection goes:
    // an event stream's handler listens for that)
    const req = Object.assign(new Readable({ read() {}, autoDestroy: false }), {
      method: head.method || 'GET', url: head.url || '/', socket: from.socket, viaLink: true,
      // (its own headers, with what says where the link came from and who opened it)
      headers: { ...Object.fromEntries(Object.entries(head.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
        ...Object.fromEntries(['authorization', 'x-forwarded-for', 'forwarded', 'host'].filter((k) => from.headers[k]).map((k) => [k, from.headers[k]])) },
    });
    if (body.length) req.push(Buffer.from(body));
    req.push(null);
    const res = answer(head.id, send, (a) => { answers.push(a); pump(); }, () => streams.set(head.id, req));
    Promise.resolve(handle(req, res)).catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); } });
  });
  ws.on('close', () => {
    for (const r of streams.values()) r.emit('close');
    streams.clear(); answers.length = 0;
    for (const a of asked.values()) a.reject(new Error('the editor is gone'));
    asked.clear(); film(link, null);
  });
  return link;
}

// a response as the HTTP handler writes one (writeHead, write, end, a file piped into it), sent over the link: whole
// once it ends, or, an event stream, each piece as it is written
function answer(id, send, queue, streaming) {
  let status = 200, headers = {}, stream = false;
  const parts = [];
  const res = new Writable({
    write(chunk, enc, done) {
      if (stream) { send({ id, more: true }, chunk).then(() => done()); return; }
      parts.push(chunk); done();
    },
    final(done) {
      if (stream) { send({ id, more: false }).then(() => done()); return; }
      res.headersSent = true;
      queue({ id, status, headers, body: Buffer.concat(parts), at: 0 });
      done();
    },
  });
  res.headersSent = false;
  res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  res.writeHead = (s, h = {}) => {
    status = s;
    for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    if (/text\/event-stream/.test(headers['content-type'] ?? '')) {
      stream = true; res.headersSent = true; streaming();
      send({ id, status, headers, more: true });
    }
    return res;
  };
  return res;
}
