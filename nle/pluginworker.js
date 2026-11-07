// The plugin instruments' socket (tools/plugins.mjs pluginSocket), held off the editor's main thread (plugins.js): each
// host's sound comes in blocks, hundreds a second each, and goes from here straight to the worklet (liveworklet.js) on a
// port of its own, so the main thread, busy drawing as the timeline plays, never handles them. What plugins.js sends the
// worklet about the hosts' sound (where they play from, which are monitored) goes through here too ({ worklet }), so it
// reaches it in order with the sound. The editor gives the port ({ port }), says where the socket is ({ connect: url }),
// what to send the studio ({ send }), and asks to know once every ready host has made its sound up to a sample
// ({ prime: { until, seq } }: answered { primed: seq }); it is told of the socket ({ open: true }, { closed: true }) and
// each of the studio's messages ({ msg }).
let ws = null, worklet = null, prime = null;
const byId = new Map(), filled = new Map();   // a ready host's id → its key; key → the sample its sound has come up to

function primed() {
  if (!prime || ![...byId.values()].every((k) => (filled.get(k) ?? 0) >= prime.until)) return;
  postMessage({ primed: prime.seq });
  prime = null;
}

function connect(url) {
  const s = (ws = new WebSocket(url));
  s.binaryType = 'arraybuffer';
  s.onopen = () => postMessage({ open: true });
  s.onclose = () => { if (ws === s) ws = null; byId.clear(); filled.clear(); postMessage({ closed: true }); };
  s.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      const m = JSON.parse(data);
      if (m.event === 'ready') byId.set(m.id, m.key);
      return postMessage({ msg: m });
    }
    const v = new DataView(data), id = v.getUint32(0, true), n = v.getUint32(4, true), pos = v.getFloat64(8, true), key = byId.get(id);
    if (!key) return;
    filled.set(key, pos + n);
    worklet?.postMessage({ plugin: { key, pos, L: new Float32Array(data, 16, n), R: new Float32Array(data, 16 + 4 * n, n) } }, [data]);
    primed();
  };
}

onmessage = ({ data: m }) => {
  if (m.port) worklet = m.port;
  if (m.connect) connect(m.connect);
  if (m.worklet) worklet?.postMessage(m.worklet);
  if (m.send) {
    const q = m.send;
    if (q.op === 'close') { for (const [id, k] of byId) if (k === q.key) byId.delete(id); filled.delete(q.key); }
    if (q.op === 'play' && !q.key) filled.clear();   // (every host: one joining keeps the others')
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(q));
  }
  if (m.prime) { prime = m.prime; primed(); }
};
