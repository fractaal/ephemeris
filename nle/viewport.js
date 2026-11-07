// The editor's own film: the film's page in the viewport's render process (app/viewport.cjs: a browser and a GPU process of
// its own, so that a heavy frame of it never holds up the editor's window), which draws the viewer's frames into images
// it shares with this window as GPU memory (app/frames.cjs), and which the editor asks what it wants to know of the film
// on a port of its own: what is under a click (pick), where the selection is at each frame shown (overlays, locate), the
// film's objects and its lanes, the camera's path. What goes over the picture, the overlays and the gizmo, and what the
// pointer does there, are the editor's own (engine/viewport.js's layer, here), drawn with each frame with the things
// selected found where that frame has them (they come with it). The film loads again when its pages do (S.film.loaded:
// its code, its settings, the cues it reads), and when its GPU device is lost; the timeline's changes reach it as they
// are made (overrides). Where it cannot load (another device, which has no way to the film's server; an app that cannot
// share frames here; a film that does not start), the studio's workers draw the viewer's frames as before.
import { linkFetch, offerFilm, onStudioAsk } from './link.js';
import { createViewportLayer } from '../engine/viewport.js';

// how each of the studio's questions about the film is asked of the film itself (as tools/nle.mjs asks its worker)
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d), list = (v) => (Array.isArray(v) ? v : []), draftOf = (b) => (Array.isArray(b.draft) ? b.draft : undefined);
const QUESTIONS = {
  'api/overlays': (b) => ['overlays', [list(b.times).slice(0, 48).map(Number), b.sel ?? null, draftOf(b), b.camera ?? null, list(b.also).slice(0, 32)]],
  'api/pick': (b) => ['pick', [num(b.t), b.camera ?? null, +b.x, +b.y]],
  'api/locate': (b) => ['locate', [num(b.t), b.camera ?? null, b.at ?? null, num(b.nth), { key: b.key ?? null, like: b.like ?? null, copy: num(b.copy), ...(list(b.sites).length && { sites: b.sites }) }, draftOf(b)]],
  'api/objects': (b) => ['objects', [{ duration: Math.max(0, num(b.duration)), fps: Math.min(24, Math.max(1, num(b.fps, 12))), cuts: list(b.cuts).map(Number).filter(Number.isFinite) }]],
  'api/stacks': (b) => ['stacks', [num(b.t), b.sel ?? { camera: true }]],
  'api/lanes': (b) => ['lanes', [Array.isArray(b.sels) ? b.sels : [b.sel ?? { camera: true }],
    { duration: Math.max(0, num(b.duration)), fps: Math.min(240, Math.max(1, num(b.fps, 60))), cuts: list(b.cuts).map(Number).filter(Number.isFinite), ...(b.values && { values: true }), ...(Number.isFinite(b.at) && { at: b.at }) }, draftOf(b)],
    (got) => (Array.isArray(b.sels) ? got : got[0])],
  'api/samples': (b) => ['samples', [b.sel ?? { camera: true }, list(b.ks).slice(0, 32), list(b.times).slice(0, 4000)]],
  'api/lights': (b) => ['lights', [num(b.t), b.camera ?? null]],
  'api/passes': (b) => ['passes', [num(b.t)]],
  'api/track': (b) => ['track', [num(b.from), num(b.to), Math.min(120, Math.max(1, num(b.fps, 60))), list(b.things).slice(0, 8)]],
  'api/director/path': (b) => ['cameraPath', [list(b.times).slice(0, 4000), draftOf(b)]],
};
// (answers the film gives the same while it and its overrides stay as they are: kept, the latest few)
const KEPT = new Set(['objects', 'stacks', 'lights', 'passes', 'cameraPath']), KEEP = 48;
// (an array or object of the editor's, as one number while it stays the same one: its camera path, the selection's path)
const ids = new WeakMap();
let lastId = 0;
const idOf = (x) => (x && typeof x === 'object' ? ids.get(x) ?? (ids.set(x, ++lastId), lastId) : x);

/**
 * The editor's film, its picture in `el` (the viewer's screen). sync(film) after each preview state (S.film): loads the
 * film again where its pages were; overrides(list) whenever the timeline's change; answer(url, body): a Response to one of
 * the studio's questions about the film (QUESTIONS), or null where the film cannot answer it here. on(event, data): what
 * the viewport says (engine/viewport.js's layer, and the film's page): a frame shown, what a click picked, the view moved,
 * a gesture set, the selection where it is, the pointer over it or not (over); and whether it draws the viewer's frames
 * changed (draws: { on }).
 */
export function createViewport({ el, on = () => {} }) {
  const app = window.studioApp?.viewport;
  const V = { port: null, ready: false, loading: false, failed: '', url: '', loaded: null, id: 0, asks: new Map(), waiting: [], kept: new Map(), overrides: null, sent: null, size: null, state: null, shownAny: false };
  // (the moment the editor last asked to see that has not been shown yet, and since when: { t, f, at }; and the moment last
  // shown)
  let asked = null, shownT = null;
  // (whether it draws the viewer's frames, or will once it is loaded: the app on the studio's own machine, its film not
  // failed; the studio's workers draw them where not, on('draws') saying when that changes)
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname), draws = () => here && !!app && !V.failed;
  const setFailed = (why) => { const was = draws(); V.failed = why; if (draws() !== was) on('draws', { on: draws() }); };
  // (the film offered to the studio while it is up, for what an agent asks of it: tools/nle.mjs askedOfFilm)
  const m = /^\/p\/([^/]+)\/([^/]+)\//.exec(location.pathname), filmKey = m && `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  const offer = (ready) => { if (filmKey) offerFilm({ key: filmKey, ready }); };

  // ---------- its picture: each frame the film draws, a VideoFrame of the image it is in (app/preload.cjs), drawn onto a
  // canvas where the editor's screen puts the frame (the part of the film's frame it was drawn of: fr)
  const pic = document.createElement('canvas'), g = pic.getContext('2d', { alpha: false });
  pic.className = 'film-picture';
  Object.assign(pic.style, { position: 'absolute', display: 'none', pointerEvents: 'none' });
  el.prepend(pic);
  let place = null, shownFr = null, showing = false;
  const within = (p, fr) => (fr && p && V.size ? { left: p.left + (p.width * (1 - fr[0] / V.size[0])) / 2, top: p.top + (p.height * (1 - fr[1] / V.size[1])) / 2, width: (p.width * fr[0]) / V.size[0], height: (p.height * fr[1]) / V.size[1] } : p);
  function placePic() {
    const r = within(place, shownFr), px = (v) => `${Math.round(v * 100) / 100}px`;
    if (r) Object.assign(pic.style, { left: px(r.left), top: px(r.top), width: px(r.width), height: px(r.height) });
    pic.style.display = r && showing && V.shownAny ? 'block' : 'none';
  }
  app?.onFrame(async (imported, meta) => {
    if (imported) {
      const vf = imported.getVideoFrame();
      try {
        if (pic.width !== meta.w || pic.height !== meta.h) { pic.width = meta.w; pic.height = meta.h; }
        g.drawImage(vf, 0, 0);
      } finally { vf.close(); }
      V.shownAny = true;
    }
    if (meta.shown) shownFr = meta.fr ?? null;
    placePic();
    if (meta.overlay) layer.drawn(meta.overlay);
    if (meta.shown) said({ event: 'shown', ...meta.shown });
  });

  // ---------- what goes over it and the pointer: the editor's own, its film asked what it needs
  let nudgeSent = 'null';
  const layer = createViewportLayer({
    mount: el,
    tell: (event, data) => on(event, data),
    at: (t, sel, also, draft, camera, ofFilm) => (V.ready ? send('overlaysAt', [t, sel, also, draft ?? null, camera, ofFilm]) : Promise.resolve(null)),
    pick: (t, camera, x, y, film) => (V.ready ? send('pick', [t, film ? null : camera, x, y]) : Promise.resolve(null)),
    moved: (camera) => { if (V.ready) send('moved', [camera]).catch(() => {}); },
    nudge: (n) => { const k = JSON.stringify(n); if (k === nudgeSent) return false; nudgeSent = k; if (V.ready) send('nudge', [n]).catch(() => {}); return true; },
  });

  function unload() {
    offer(false);
    for (const a of V.asks.values()) a.reject(new Error('The film was loaded again.'));
    V.asks.clear(); V.port?.close(); V.port = null; V.ready = false; V.kept.clear(); V.sent = null; nudgeSent = 'null';
  }
  async function load(loaded) {
    unload();
    V.loaded = loaded; setFailed(''); V.loading = true;
    let url = '';
    try { url = (await (await linkFetch('api/state')).json()).url ?? ''; } catch { /* the studio answers then */ }
    if (V.loaded !== loaded) return;
    const at = url && new URL(url, location.href);
    // (a film this device cannot reach, or an app that cannot share frames here: the studio's)
    if (!app || !at || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(at.hostname)) { V.loading = false; setFailed('not here'); return flush(); }
    at.searchParams.set('viewport', 'worker');
    V.url = at.href;
    if (!(await app.load(V.url))) { V.loading = false; setFailed('frames cannot be shared here'); return flush(); }
  }
  // what the film's page says of itself (app/preload.cjs: viewport-ready with its port, -failed, -lost)
  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d?.viewportWorker) return;
    if (d.ephemeris === 'viewport-lost') { console.warn(`the editor's film was lost (${d.message}): loading it again`); return load(V.loaded); }
    if (d.ephemeris === 'viewport-failed') { V.loading = false; setFailed(d.error ?? 'failed'); console.warn(`the film did not start in the editor: ${String(d.error).split('\n')[0]}`); return flush(); }
    if (d.ephemeris !== 'viewport-ready' || !e.ports[0]) return;
    unload();
    V.size = d.size ?? null; V.loading = false;
    V.port = e.ports[0];
    V.port.onmessage = ({ data }) => said(data);
    V.ready = true; V.viewed = null; offer(true);
    if (V.overrides) send('overrides', [V.overrides]);
    if (V.state) send('overlayState', [V.state]).catch(() => {});
    flush();
  });
  // what the film says: an event of its own (a frame shown, a question's stage…), or an answer
  function said(data) {
    if (data.event) {
      if (data.event === 'failed') console.warn(`the editor's film: ${data.error}`);
      if (data.event === 'shown') { shownT = data.t; if (asked && data.t === asked.t) asked = null; }
      on(data.event, data); return;
    }
    const { id, ok, error } = data, a = V.asks.get(id);
    V.asks.delete(id);
    if (error != null) a?.reject(new Error(error)); else a?.resolve(ok);
  }
  // what was asked while the film loaded: of it once it is ready, else of the studio
  const flush = () => { for (const w of V.waiting.splice(0)) w(); };
  function send(call, args) {
    const id = ++V.id;
    return new Promise((resolve, reject) => { V.asks.set(id, { resolve, reject }); V.port.postMessage({ id, call, args }); });
  }
  function call(name, args) {
    if (!KEPT.has(name) && !(name === 'lanes' && args[1]?.at == null)) return send(name, args);
    const key = JSON.stringify([name, args]);
    let p = V.kept.get(key);
    if (!p) { p = send(name, args); p.catch(() => { if (V.kept.get(key) === p) V.kept.delete(key); }); }
    V.kept.delete(key); V.kept.set(key, p);
    if (V.kept.size > KEEP) V.kept.delete(V.kept.keys().next().value);
    return p;
  }
  // (the studio's question, an agent's: answered as the editor's own are, while the film is up; else the studio's own)
  onStudioAsk((url, body) => {
    if (!V.ready) return null;
    // (a frame for it, drawn by the film while the director leaves the view still: engine/runtime.js __agentFrame)
    if (url === 'api/director') return send('agentFrame', ['director', body]).then((jpg) => new Response(jpg, { headers: { 'content-type': 'image/jpeg' } }));
    if (url === 'api/profile') return send('agentFrame', ['profile', body]).then((p) => new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json' } }));
    const q = QUESTIONS[url];
    if (!q) return null;
    const [name, args, shape = (x) => x] = q(body ?? {});
    return call(name, args).then((x) => new Response(JSON.stringify(shape(x) ?? null), { headers: { 'content-type': 'application/json' } }));
  });
  return {
    get ready() { return V.ready; },
    /** Whether it is loading (the film loading again, the picture before staying meanwhile). */
    get loading() { return V.loading && !V.failed; },
    /** Whether it draws the viewer's frames, or will once loaded (the studio's workers draw them where not). */
    get draws() { return draws(); },
    /** The moment asked for (view) and not shown yet, and how long it has been waited for: { t, f, ms }, or null. */
    get late() { return asked && { t: asked.t, f: asked.f, ms: performance.now() - asked.at }; },
    /** The picture, once the film has drawn one (its canvas), or null. */
    get frame() { return V.shownAny ? pic : null; },
    /** The preview's state changed (S.film): the film loaded again where its pages were. */
    sync(film) { if (film && film.loaded !== V.loaded && !film.error) load(film.loaded); },
    /** The timeline's overrides as the editor has them now (liveEdits of it): the film takes them in at once. */
    overrides(list) {
      const key = JSON.stringify(list);
      if (key === V.sent) return;
      V.overrides = list; V.sent = key; V.kept.clear();
      layer.changed();
      if (V.ready) send('overrides', [list]).catch(() => {});
    },
    /** What the editor's viewer shows (engine/runtime.js __view: { view, t, camera, look, scale, draft, playing, n, place }),
     *  drawn by the film; each frame shown comes to shown(). */
    view(state) {
      // (another moment asked for, playing aside: waited for until a frame of it is shown)
      if (state.playing) asked = null;
      else if (state.t !== shownT && state.t !== asked?.t) asked = { t: state.t, f: state.f ?? null, at: performance.now() };
      showing = state.view === 'film' || state.view === 'director';
      layer.show(showing && draws());
      if (state.place) { place = state.place; layer.place(place); }
      placePic();
      const s = { ...layer.view(state), dpr: devicePixelRatio };
      const key = JSON.stringify(s);
      if (!V.ready || key === V.viewed) return;
      V.viewed = key;
      send('view', [s]).catch(() => { V.viewed = null; });
    },
    /** What is selected and how the overlays are set (app.js overlayState), as it changes: what is drawn over the picture
     *  and what its gizmo is of (here), and what the film finds for each frame (there). */
    overlayState(state) {
      const key = JSON.stringify({ ...state, camPath: idOf(state.camPath), path: state.path && { runs: idOf(state.path.runs), points: state.path.points } });
      if (key === V.stateKey) return;
      V.stateKey = key; V.state = state;
      layer.setState(state);
      if (V.ready) send('overlayState', [state]).catch(() => {});
    },
    /** A key the editor was given, for the viewport (a gesture under way there; G R S with the pointer over it): a
     *  promise of whether it took it. */
    key: (k) => Promise.resolve(layer.key({ type: k.type, key: k.key, code: k.code, shiftKey: k.shiftKey, ctrlKey: k.ctrlKey, altKey: k.altKey, metaKey: k.metaKey, repeat: k.repeat, preventDefault() {} })),
    /** The editor's edit of a gesture there: made, or not (the thing then drawn as it was). */
    committed(ok) { if (!ok) layer.dropped(); },
    /** A question about the film, by the studio's url for it: a promise of its Response, or null (the studio's to answer). */
    answer(url, body) {
      const q = QUESTIONS[url];
      if (!q || V.failed) return null;
      const [name, args, shape = (x) => x] = q(body ?? {});
      const ask = () => call(name, args).then((x) => new Response(JSON.stringify(shape(x) ?? null), { headers: { 'content-type': 'application/json' } }));
      if (V.ready) return ask();
      return new Promise((resolve) => V.waiting.push(() => resolve(V.ready ? ask() : null))).then((r) => r ?? linkFetch(url, { method: 'POST', body: JSON.stringify(body) }));
    },
  };
}
