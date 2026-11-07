// The Preview's frames in the editor's own film (engine/runtime.js ?viewport): the frames of the studio's cache
// (tools/preview.mjs: PNGs, lossless), read over a viewer socket of this page's own (tools/nle.mjs viewerSocket) and
// decoded off its thread (createImageBitmap), so that what the Preview shows comes to the canvas its overlays are drawn
// with, and no frame passes through the editor. The studio sends the frames it stores between `from` and `to` as it
// stores them; a frame asked for (want) comes as the cache has it. Kept here, decoded, the nearest to the playhead.

const KEEP = 36;   // (decoded frames kept, the nearest the playhead: a second and a half at 24 fps, ahead and behind)

/**
 * The cache's frames, as the studio's viewer socket sends them. onFrame(f): one came (decoded), or the cache has none
 * of f now (asked for).
 */
export function createPreviewFrames({ onFrame = () => {} } = {}) {
  let ws = null, url = '', open = false, view = '', at = '', retry = null, playhead = 0, timed = false;
  const kept = new Map();     // (f → { bmp, gen, state, size, look }: decoded)
  const asked = new Map();    // (f → when it was asked for, not yet come)
  const send = (m) => { if (open) ws.send(JSON.stringify(m)); return open; };
  function connect() {
    clearTimeout(retry);
    if (!url) return;
    const s = (ws = new WebSocket(url));
    s.binaryType = 'arraybuffer';
    s.onopen = () => { open = true; view = ''; at = ''; asked.clear(); if (timed) send({ type: 'stats', on: true }); };
    s.onclose = () => { if (ws !== s) return; ws = null; open = false; asked.clear(); retry = setTimeout(connect, 1000); };
    s.onmessage = async ({ data }) => {
      if (typeof data === 'string') { const q = JSON.parse(data); if (q.kind === 'none') { asked.delete(q.f); onFrame(q.f); } return; }
      const n = new DataView(data).getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, n)));
      if (head.kind !== 'frame') return;
      asked.delete(head.f);
      let bmp;
      try { bmp = await createImageBitmap(new Blob([new Uint8Array(data, 4 + n)], { type: head.type ?? 'image/png' })); } catch { return; }
      // (a frame read from the cache just before the cache stored it again can come after the one stored)
      const c = kept.get(head.f);
      if (c && c.look === head.look && (c.gen > head.gen || (c.gen === head.gen && c.state >= 2 && head.state < 2))) return bmp.close();
      c?.bmp.close();
      kept.set(head.f, { bmp, gen: head.gen, state: head.state, size: head.size, look: head.look, profile: head.profile ?? null });
      if (kept.size > KEEP) for (const k of [...kept.keys()].sort((a, b) => Math.abs(b - playhead) - Math.abs(a - playhead)).slice(0, kept.size - KEEP)) { kept.get(k).bmp.close(); kept.delete(k); }
      onFrame(head.f);
    };
  }
  return {
    /** The studio's viewer socket for the timeline the editor shows (ws:…/api/viewer): opened, again a second after it drops. */
    use(u) { if (u === url) return; url = u; ws?.close(); ws = null; open = false; connect(); },
    /** The size the viewer shows the film at (of its frame: the cache draws its frames at it), its frames lossless; this
     *  page draws the viewer's frames, and gives the cache each it draws (put). */
    view(w, h, scale) { const m = { type: 'view', delivery: 'lossless', w, h, scale, fills: true }, k = JSON.stringify(m); if (k !== view && send(m)) view = k; },
    /** A frame drawn here (its RGBA rows, w × h) at size z, of the film's version gen and of the timeline as the film saw
     *  it (key), given to the cache to keep (tools/preview.mjs put); whether it was sent. */
    put(f, { data, w, h }, z, gen, key, look) {
      if (!open) return false;
      const head = new TextEncoder().encode(JSON.stringify({ type: 'put', f, w, h, z, gen, key, look }));
      const out = new Uint8Array(4 + head.length + data.byteLength);
      new DataView(out.buffer).setUint32(0, head.length, true);
      out.set(head, 4); out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 4 + head.length);
      ws.send(out);
      return true;
    },
    get ready() { return open; },
    /** Stats on: the cache's frames come with what drawing each took (where it was timed: drawn while Stats was on). */
    stats(on) { if (on !== timed) { timed = on; send({ type: 'stats', on }); } },
    /** The director is at work here (scrubbing, turning the view, a gesture): the studio's workers start no frame of the
     *  cache for `ms` (those under way finish), as the frames the editor asked of them once held them (tools/nle.mjs). */
    hold(ms) { send({ type: 'hold', ms }); },
    /** Where the playhead is (the cache draws that frame first, and those ahead while playing) and which frames to send as
     *  they are stored. */
    at(f, playing, every, from, to) { playhead = f; const m = { type: 'at', f, playing, every, from, to }, k = JSON.stringify(m); if (k !== at && send(m)) at = k; },
    /** Frame f as the cache has it now, asked for (unless it was a moment ago). */
    want(f) { const t = asked.get(f); if ((t && performance.now() - t < 2000) || asked.size >= 8) return; if (send({ type: 'get', f })) asked.set(f, performance.now()); },
    /** Frame f as it came, decoded: { bmp, gen, state, size, look, profile }, or none. */
    kept: (f) => kept.get(f) ?? null,
    /** Every frame kept dropped (the film loaded again elsewhere, say). */
    clear() { for (const c of kept.values()) c.bmp.close(); kept.clear(); asked.clear(); },
  };
}
