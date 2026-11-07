// The editor's viewport (nle/viewport.js; the film draws its picture in a render process of its own, engine/runtime.js
// ?viewport=worker): what is drawn over its picture, the overlays (overlays.js) and the gizmo (gizmo.js), and what the
// pointer and the keys do over it, drawn with each frame the picture shows (the things selected found where that frame
// has them, which come with it), so that they keep in step with it; the gizmo moving as the pointer does, whatever a
// frame of the film takes. The editor keeps the selection, the timeline and its undo, the
// toolbar and the inspector: it says what is selected and how the overlays are set (state), and is told what a click
// picked, where the view was moved to, what a gesture set and the keys this does not take (events), each of which it
// makes its own.
import { basis, W, H } from './lens.js';
import { createGizmo } from './gizmo.js';
import { gridSvg, lightsSvg, outlinesSvg, outlineOf, membersOf, pathSvg, cameraSvg, pinsSvg } from './overlays.js';

const CAMK = { rx: 'pitch', ry: 'yaw', rz: 'roll', s: 'zoom' };
const GESTURES = { KeyG: 'move', KeyR: 'rotate', KeyS: 'scale' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const refOf = (x) => x && { at: x.at, nth: x.nth, key: x.key, like: x.like, copy: x.copy, ...(x.sites && { sites: x.sites }) };

/**
 * The layer over the viewport's picture. tell(event, data): an event for the editor. at(t, sel, also, draft, camera):
 * what is drawn over the frame at t, the film camera's pose, the lights and the things selected, each found where it is
 * (runtime.js __overlays). pick(t, camera, x, y): what is at a point of the frame (__pick). moved(camera): the view moved
 * here, to be drawn from that camera. nudge(n): the frame drawn with a gesture's change as it goes ({ refs, vals, v0,
 * camera }) or as it is (null); whether that changed what is drawn. mount: the element it covers (the editor's screen,
 * the keys and what is dropped there being the editor's to give it: key()); else the page.
 */
export function createViewportLayer({ tell, at, pick, moved, nudge, mount = null }) {
  const host = document.createElement('div');
  if (mount) host.className = 'film-layer';
  Object.assign(host.style, { position: mount ? 'absolute' : 'fixed', inset: '0', zIndex: mount ? '2' : '2147483647', display: 'none' });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<link rel="stylesheet" href="${new URL('./overlays.css', import.meta.url).href}"><style>
    .pad { position: absolute; inset: 0; touch-action: none; cursor: grab; user-select: none; }
    .pad:active { cursor: grabbing; }
  </style><div class="pad"><svg class="obj-ov" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg><div class="gizmo-hud" hidden></div></div>`;
  (mount ?? document.body).append(host);
  const pad = root.querySelector('.pad'), svg = root.querySelector('svg'), hud = root.querySelector('.gizmo-hud');

  let state = null;          // (the editor's: what is selected, how the overlays are set: setState)
  let frame = null;          // (the frame shown: { t, camera, gen, draft })
  let data = null, dataKey = '';   // (what is drawn over it, the things selected found there: at)
  let painted = '', place = null, over = false;
  let viewCam = null, seq = 0, film = false;   // (the view's camera as moved here, and how many times; film: the Preview, through the film's own camera, which nothing here moves)
  let mouse = null, client = null, down = null, drag = null, point = null, wheeling = null, gesture = false;
  let held = null;           // (a gesture set, { nudge, outline }: drawn as it left it until the editor's edit of it comes)

  const sel = () => (state?.sel ? data?.sel ?? null : state?.target ?? null);
  // (a point of the pointer's in the frame: place is in CSS px of what it covers, its page or the editor's screen)
  const origin = () => (mount ? mount.getBoundingClientRect() : { left: 0, top: 0 });
  const toFrame = (e) => { if (!place) return null; const o = origin(); return [((e.clientX - o.left - place.left) / place.width) * W, ((e.clientY - o.top - place.top) / place.height) * H]; };
  const gizmo = createGizmo({
    sel,
    cam: () => frame?.camera ?? null,
    k: () => W / (place?.width || W),
    mouse: () => mouse,
    // (the values it starts from: the thing's as it is found here, the film camera's as the editor's lanes have them)
    shown: (k) => {
      if (!state?.sel) return state?.target?.values?.[CAMK[k] ?? k] ?? null;
      const w = data?.sel?.where;
      if (!w) return null;
      if (k === 's') return Array.isArray(w.s) ? w.s[0] : w.s ?? 1;
      return w[k] ?? (/^(x|y|z|rx|ry|rz)$/.test(k) ? 0 : null);
    },
    edits: () => null, doc: () => null,
    commit: (vals, outline, v0) => { held = { nudge: changeOf(vals, v0), outline }; tell('gizmo', { vals, v0 }); },
    hud(html) {
      hud.hidden = !html;
      if (html) hud.innerHTML = `${html}${state?.into ? `<span class="into">${esc(state.into)}</span>` : ''}`;
      if (!!html !== gesture) { gesture = !!html; tell('gesture', { on: gesture }); }
    },
    // (the picture drawn with the change as it goes, the overlays with it; or, the picture as it was, the overlays now)
    paint: () => {
      // (and its values to the editor as they go, for its inspector)
      const v = gizmo.active && gizmo.values();
      if (v && state?.sel) tell('dragging', { vals: v.vals });
      if (!nudge(gizmo.active ? live() : held?.nudge ?? null)) paint();
    },
    toast: (text) => tell('toast', { text }),
  });
  // (a gesture's change: of the things selected, or of the film camera)
  const changeOf = (vals, v0) => (Object.keys(vals).length ? { refs: state?.sel ? [refOf(state.sel), ...(state.also ?? []).map(refOf)] : [], vals, v0, camera: !state?.sel } : null);
  const live = () => { const v = gizmo.values(); return v && changeOf(v.vals, v.v0); };

  // ---------- what is drawn over the frame shown
  function paint() {
    if (!frame || !state || !place) { if (painted) { svg.innerHTML = ''; painted = ''; } return; }
    const show = state.show ?? {}, on = (k) => show.on && !!show[k];
    const B = frame.camera && basis(frame.camera), k = W / (place.width || W), out = [];
    if (B) {
      if (on('grid')) out.push(gridSvg(B));
      if (on('camera') && !state.lock) out.push(cameraSvg(state.camPath, B, { cuts: state.cuts ?? [], t: frame.t, W, H, k, selected: state.camSel }));
      if (on('lights')) out.push(lightsSvg(data?.lights, B));
      const members = state.sel?.sites && !gizmo.active ? membersOf(data?.sel, B) : null;
      const own = gizmo.outline() ?? held?.outline ?? (members ? null : outlineOf(data?.sel, B));
      if (on('selection')) out.push(outlinesSvg({ members, sel: state.sel && own, also: gizmo.active ? [] : (data?.also ?? []).map((x) => x && outlineOf(x, B)) }));
      if (state.path) out.push(pathSvg(state.path.runs, state.path.points, B, { k, t: frame.t }));
      if ((state.sel && data?.sel) || state.target) out.push(gizmo.svg(show.on ? show : {}));
      if (state.cues) out.push(pinsSvg(state.pins, B));
    }
    const html = out.join('');
    if (html !== painted) { svg.innerHTML = html; painted = html; }
  }
  // the things selected found where they are at frame f, before it is drawn (the latest asked for, the one kept)
  async function prepare(f) {
    if (gizmo.active || !f) return;
    const key = JSON.stringify([f.t, f.gen, f.draft ?? null, refOf(state?.sel) ?? null, (state?.also ?? []).map(refOf), !!f.film]);
    if (key === dataKey) return;
    dataKey = key;
    const d = await at(f.t, refOf(state?.sel) ?? null, (state?.also ?? []).map(refOf), f.draft, f.camera, !!f.film);
    if (dataKey !== key) return;
    data = d;
    report();
  }
  // what the editor shows of the things selected (its inspector, its toolbar): as they are at the frame shown
  const report = () => data && tell('now', { t: data.t, sel: data.sel ?? null, also: data.also ?? [], camera: data.camera ?? null, lights: data.lights ?? [] });

  // ---------- the pointer: the view turned (drag), moved (right- or Shift-drag), dollied (wheel); a click, what is there;
  // the gizmo's parts, a gesture; a point on the path, the playhead there (dragged: the thing moved there)
  const setCam = (c, done = false) => { viewCam = c; seq++; moved(c); tell('camera', { cam: c, seq, done }); };
  // (the pointer over the picture or not: where G, R and S go, the editor's keys being its own)
  pad.addEventListener('pointerenter', () => { over = true; tell('over', { on: true }); });
  pad.addEventListener('pointerleave', () => { over = false; tell('over', { on: false }); });
  pad.addEventListener('pointerdown', (e) => {
    if (!state || !frame) return;
    e.preventDefault();
    mouse = toFrame(e); client = [e.clientX, e.clientY];
    // (a gesture from the keys: a click sets it, a right click puts it back, and neither picks)
    if (gizmo.active && !gizmo.dragging) { gizmo.finish(e.button === 0); return; }
    pad.setPointerCapture(e.pointerId);
    const p = e.target.closest?.('.path-pt');
    if (p && e.button === 0) { tell('point', { i: +p.dataset.pt }); point = { x: e.clientX, y: e.clientY }; return; }
    const h = e.target.closest?.('.gz');
    if (h && e.button === 0) { gizmo.start(h.dataset.gz, { axis: h.dataset.axis || null, drag: true }); return; }
    down = { x: e.clientX, y: e.clientY, button: e.button, add: e.shiftKey || e.ctrlKey || e.metaKey };
    if (viewCam && !film) drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey, cam: { ...viewCam }, moved: false };
  });
  pad.addEventListener('pointermove', (e) => {
    mouse = toFrame(e); client = [e.clientX, e.clientY];
    if (point && Math.hypot(e.clientX - point.x, e.clientY - point.y) > 4) { point = null; gizmo.start('move', { drag: true, bare: true }); }
    if (gizmo.active) { gizmo.move(mouse, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (!drag || !place) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, c = { ...drag.cam };
    if (!drag.pan) { c.yaw -= dx * 0.3; c.pitch = Math.max(-89, Math.min(89, c.pitch + dy * 0.3)); }
    else {
      const B = basis(drag.cam), s = W / place.width / c.zoom;   // (world px per screen px, at the target)
      for (const [j, a] of [[0, 'x'], [1, 'y'], [2, 'z']]) c[a] = (c[a] ?? 0) - (B.right[j] * dx + B.down[j] * dy) * s;
    }
    drag.moved = true;
    setCam(c);
  });
  const up = (e) => {
    if (point) { point = null; return; }
    if (gizmo.dragging) { gizmo.finish(true); return; }
    const d = down, g = drag;
    down = drag = null;
    if (g?.moved) tell('camera', { cam: viewCam, seq, done: true });
    // (a click, not a drag, on the picture)
    const m = toFrame(e);
    if (d?.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4 && m && m[0] >= 0 && m[0] <= W && m[1] >= 0 && m[1] <= H) {
      const { t, camera } = frame;
      pick(t, camera, m[0], m[1], frame.film).then((r) => tell('picked', { r: r ?? null, x: m[0], y: m[1], add: d.add, t }), (err) => tell('toast', { text: `Could not pick: ${err.message}` }));
    }
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', () => { point = null; down = null; if (gizmo.dragging) gizmo.finish(false); if (drag?.moved) tell('camera', { cam: viewCam, seq, done: true }); drag = null; });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  pad.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!viewCam || film) return;
    setCam({ ...viewCam, zoom: viewCam.zoom * Math.exp(-e.deltaY * 0.0015) });
    clearTimeout(wheeling);
    wheeling = setTimeout(() => { wheeling = null; tell('camera', { cam: viewCam, seq, done: true }); }, 300);
  }, { passive: false });
  // (something dragged in from outside, a file or an asset: never this page's to open, the editor's to place)
  if (!mount) for (const type of ['dragenter', 'dragover', 'drop']) addEventListener(type, (e) => { e.preventDefault(); if (type === 'dragenter') tell('drag', {}); });

  // ---------- the keys this page is given (it was clicked last): a gesture's, G R S over the picture; the rest the editor's
  const forward = (e) => {
    if (!e.ctrlKey && !e.metaKey) e.preventDefault();
    tell('key', { type: e.type, key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, client: over ? client : null });
  };
  function key(e) {
    if (gizmo.active) return gizmo.key(e);
    if (over && (state?.sel ? data?.sel : state?.target) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && GESTURES[e.code]) { gizmo.start(GESTURES[e.code]); return true; }
    return false;
  }
  if (!mount) {
    addEventListener('keydown', (e) => { if (key(e)) e.preventDefault(); else forward(e); });
    addEventListener('keyup', (e) => { if (e.key === 'Control') gizmo.setCtrl(false); forward(e); });
  }

  return {
    /** Shown (the Director view) or not. */
    show(on) {
      host.style.display = on ? 'block' : 'none';
      if (!on) { if (gizmo.active) gizmo.finish(false); drag = down = point = null; }
    },
    /** Where the picture is, in CSS px of the page (the editor's screen): the overlays over it. */
    place(p) {
      if (!p) return;
      place = p;
      Object.assign(svg.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
    },
    /**
     * The editor's view state as this page takes it (runtime.js __view): its camera, unless the view was moved here since
     * the editor last heard of it (state.camSeq, the last of this page's moves it has).
     */
    view(s) {
      film = s?.view === 'film';
      if (s?.camera && typeof s.camera === 'object' && (s.camSeq ?? 0) >= seq) viewCam = s.camera;
      return s && viewCam && typeof s.camera === 'object' ? { ...s, camera: viewCam } : s;
    },
    /** What is selected and how the overlays are set (the editor's, as it changes). */
    setState(s) {
      const was = JSON.stringify([refOf(state?.sel) ?? null, (state?.also ?? []).map(refOf)]);
      state = s;
      for (const [k, v] of Object.entries(s?.colors ?? {})) host.style.setProperty(k, v);   // (the editor's: overlays.css)
      // (what was selected, no more, or another thing: a gesture under way left)
      if (gizmo.active && !(s?.sel || s?.target)) gizmo.finish(false);
      // (another thing selected: found at the frame shown, then drawn over it)
      if (frame && JSON.stringify([refOf(s?.sel) ?? null, (s?.also ?? []).map(refOf)]) !== was) prepare(frame).then(paint, paint);
      else paint();
    },
    /** Before a frame of the view is drawn: what goes over it found (the things selected where they are then). */
    prepare,
    /** A frame of the view was shown (its time, camera, the overrides it was drawn with, and what goes over it where it
     *  was found for it: data): what goes over it drawn. */
    drawn(f) {
      frame = f;
      if (f && 'data' in f && !gizmo.active) {
        data = f.data;
        dataKey = JSON.stringify([f.t, f.gen, f.draft ?? null, refOf(state?.sel) ?? null, (state?.also ?? []).map(refOf), !!f.film]);
        report();
      }
      paint();
    },
    /** The timeline's changes came (the editor's edit of a gesture among them): drawn as they are now. */
    changed() { held = null; dataKey = ''; },
    /** The editor's edit of a gesture failed: the thing as it was. */
    dropped() { held = null; nudge(null); paint(); },
    /** A key the editor was given (with the pointer over the picture, or a gesture under way): whether it was taken. */
    key: (k) => (k.type === 'keyup' ? (k.key === 'Control' && gizmo.setCtrl(false), gizmo.active) : key(k)),
    /** Whether a gesture is under way. */
    get gesture() { return gizmo.active; },
  };
}
