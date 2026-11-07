// The studio link end to end: the editor's end (nle/link.js) against a server's (link.mjs) as the studio serves it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { serveLink } from './link.mjs';

// a studio's handler in small: an answer, a large one, an event stream, a request's body echoed
const big = Buffer.alloc(24 * 1024 * 1024, 7);
const closedStreams = [];
async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), at = (p) => u.pathname.endsWith(p);
  if (at('/api/state')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, q: u.searchParams.get('q') })); }
  if (at('/files/big')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(big); }
  if (at('/api/echo')) { const parts = []; for await (const p of req) parts.push(p); res.writeHead(201, { 'content-type': 'text/plain' }); return res.end(`${req.method} ${Buffer.concat(parts)}`); }
  if (at('/api/missing')) { res.writeHead(404, {}); return res.end(); }
  if (at('/api/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hi\n\n');
    let n = 0;
    const tick = setInterval(() => res.write(`event: count\ndata: ${++n}\n\n`), 20);
    req.on('close', () => { clearInterval(tick); closedStreams.push(n); });
  }
}
const server = http.createServer(handle), sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => serveLink(ws, req, handle)));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
globalThis.location = new URL(`http://127.0.0.1:${server.address().port}/p/film/main/`);
const { linkFetch, LinkEvents } = await import('../nle/link.js');
after(() => { for (const c of sockets.clients) c.terminate(); server.close(); });

test('a request over the link is answered as it is over HTTP', async () => {
  const r = await linkFetch('api/state?q=lanes');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual(await r.json(), { ok: true, q: 'lanes' });
  const echo = await linkFetch('api/echo', { method: 'POST', body: JSON.stringify({ t: 3 }) });
  assert.deepEqual([echo.status, await echo.text()], [201, 'POST {"t":3}']);
  assert.equal((await linkFetch('/api/missing')).status, 404);
});

test('a large answer does not hold up a small one asked after it', async () => {
  const order = [];
  const large = linkFetch('/files/big').then(async (r) => { order.push('big'); return (await r.arrayBuffer()).byteLength; });
  const small = linkFetch('api/state').then(() => order.push('small'));
  const [bytes] = await Promise.all([large, small]);
  assert.equal(bytes, big.length);
  assert.deepEqual(order, ['small', 'big']);
});

test('an event stream brings its events as they are written, and ends at the studio when closed', async () => {
  const es = new LinkEvents('api/events'), got = [];
  await new Promise((resolve) => es.addEventListener('count', (e) => { got.push(+e.data); if (got.length === 3) resolve(); }));
  assert.deepEqual(got, [1, 2, 3]);
  es.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closedStreams.length, 1);
});
