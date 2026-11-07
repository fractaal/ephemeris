// The viewer's socket (tools/nle.mjs viewerSocket), held off the editor's main thread (app.js openViewerSocket): its
// pictures come in and are decoded here, each drawn at the viewer's size, so that while the timeline plays (the editor's
// own drawing filling its main thread) they come as fast as the studio sends them. The editor says where the socket is
// ({ open: url }), the size its pictures are drawn at ({ fit: [w, h] }; 0: as they come), what to send the studio
// ({ send, quick }: quick, an ask whose picture is scaled quickly, as it moves) and, in the studio's own window, how frames
// in memory are read ({ reader: a port }: app/framefile.cjs); it is told of the socket ({ open: true }, { closed: true }),
// each text message ({ text }) and each picture ({ head, bytes, bmp }, or { head, bytes, error }; unread: a frame in memory
// could not be read).
let ws = null, fit = [0, 0], reader = null, readId = 0;
const quick = new Map();   // (an ask's id → whether its picture is scaled quickly)
const reading = new Map();   // (a frame in memory being read: its id → what to do with it)

// (decoded whole, then scaled on a canvas: as smooth as createImageBitmap's high-quality resize, which with several
// frames decoding at once took half as long again)
async function picture(source, fast) {
  const full = await createImageBitmap(source), [w, h] = fit;
  if (!w || !h || (full.width === w && full.height === h)) return full;
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.imageSmoothingQuality = fast ? 'low' : 'high';
  g.drawImage(full, 0, 0, w, h);
  full.close();
  return c.transferToImageBitmap();
}
// a frame in memory (app/framefile.cjs), as a picture's source
function frameIn(file, w, h) {
  if (!reader) return Promise.reject(new Error('nothing reads frames here'));
  const id = ++readId;
  return new Promise((resolve, reject) => {
    reading.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(new ImageData(new Uint8ClampedArray(m.px.buffer, m.px.byteOffset, m.px.byteLength), w, h))));
    reader.postMessage({ id, file, n: w * h * 4 });
  });
}

function open(url) {
  const s = (ws = new WebSocket(url));
  s.binaryType = 'arraybuffer';
  s.onopen = () => postMessage({ open: true });
  s.onclose = () => { if (ws === s) ws = null; quick.clear(); postMessage({ closed: true }); };
  s.onmessage = async ({ data }) => {
    if (typeof data === 'string') return postMessage({ text: data });
    // (a kept frame is a PNG, or a JPEG compressed for this viewer; a frame drawn now a JPEG, or where it is in memory)
    const n = new DataView(data).getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, n)));
    const kept = head.kind === 'frame', fast = !kept && !!quick.get(head.id);
    if (!kept && !head.partial) quick.delete(head.id);
    try {
      const bmp = await picture(head.file ? await frameIn(head.file, head.w, head.h) : new Blob([new Uint8Array(data, 4 + n)], { type: kept ? head.type ?? 'image/png' : 'image/jpeg' }), fast);
      postMessage({ head, bytes: data.byteLength, bmp }, [bmp]);
    } catch (e) { postMessage({ head, bytes: data.byteLength, error: String(e?.message ?? e), ...(head.file && { unread: true }) }); }
  };
}

onmessage = ({ data: m }) => {
  if (m.open) open(m.open);
  if (m.fit) fit = m.fit;
  if (m.reader) {
    reader = m.reader;
    reader.onmessage = ({ data: r }) => { const done = reading.get(r.id); reading.delete(r.id); done?.(r); };
  }
  if (m.send) {
    if (m.send.id != null) quick.set(m.send.id, !!m.quick);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m.send));
  }
};
