// Layers: DOM content captured into GPU textures with HTML-in-Canvas (children of a <canvas layoutsubtree>).
//
// Conventions (see README):
// - A layer is authored at the size it is designed at (w x h CSS px) plus `pad` on every side. Glows, shadows and
//   anything else that spills past the component live inside the padding; the texture edge is always transparent,
//   so nothing gets clipped and plane edges never alias.
// - `res` is the layer's capture resolution: set it to the largest on-screen scale the layer will be seen at
//   (a hero close-up at 2.5x needs res 2.5). It is applied as CSS zoom over the page's own scale (res / its
//   devicePixelRatio), so that a layer is captured at res device pixels a CSS pixel on any display: a render worker's
//   page at scale 1 and the film in the editor's frame on a display at 1.67 or 2 capture its shapes and pictures alike
//   (text, which Chromium lays out on a scaled display, can sit a device pixel apart). It never changes during the
//   film, so the layout never reflows. Smaller on-screen sizes come from the mip chain.
// - `live` layers are re-captured every frame (their DOM animates on the film clock); static ones once.
import { pin, rest } from './time.js';
import { placed } from './mesh.js';
import { settle, motionsUsed, STACKS } from './motion.js';

export function createHost() {
  document.documentElement.style.background = '#000';
  Object.assign(document.body.style, { margin: '0', overflow: 'hidden', background: '#000' });
  const canvas = document.createElement('canvas');
  canvas.setAttribute('layoutsubtree', '');
  // layers stack inside the host; it is never displayed, only painted for capture. Children are captured in the
  // canvas's bitmap space, so its bitmap must match its CSS box at device scale (fit() sizes both to the layers).
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0' });
  document.body.append(canvas);
  const waiters = [];
  canvas.addEventListener('paint', () => { const w = waiters.splice(0); w.forEach((f) => f()); });
  return {
    canvas,
    /** Sizes the host to contain every layer (call once all layers exist). */
    fit() {
      const dpr = window.devicePixelRatio || 1;
      let w = 1, h = 1;   // (device pixels; - 1e-3: a size a zoom makes 100.0000001 is 100)
      for (const el of canvas.children) { const r = el.getBoundingClientRect(); w = Math.max(w, Math.ceil(r.width * dpr - 1e-3)); h = Math.max(h, Math.ceil(r.height * dpr - 1e-3)); }
      Object.assign(canvas.style, { width: `${w / dpr}px`, height: `${h / dpr}px` });
      canvas.width = w; canvas.height = h;
    },
    /** Resolves after the next rendering update, when every layer's paint reflects the current DOM. */
    nextPaint: () => new Promise((r) => { waiters.push(r); canvas.requestPaint?.(); }),
  };
}

export class Layer {
  /**
   * @param {HTMLElement} content  the component (sized to w x h by the layer; 'auto' measures its natural size)
   * @param {{ w: number|'auto', h: number|'auto', pad?: number, res?: number, live?: boolean|[number, number], label?: string }} o
   *   live: true = re-captured every frame; [t0, t1] = only while its DOM animates
   */
  constructor(host, content, { w = 'auto', h = 'auto', pad = 48, res = 1, live = false, label = '' }) {
    Object.assign(this, { pad, res, live, label, content });
    this.zoom = res / (window.devicePixelRatio || 1);   // (CSS pixels of the page a layout pixel of the layer: see res above)
    this.el = document.createElement('div');
    this.el.className = 'h-layer';
    Object.assign(this.el.style, { position: 'absolute', left: '0', top: '0', boxSizing: 'border-box', padding: `${pad}px`, zoom: String(this.zoom) });
    if (w !== 'auto') content.style.width = `${w}px`;
    if (h !== 'auto') content.style.height = `${h}px`;
    content.style.position ||= 'relative';
    if (w === 'auto') content.style.width = 'max-content';
    this.el.append(content);
    host.canvas.append(this.el);
    this.w = w === 'auto' ? Math.ceil(content.getBoundingClientRect().width / this.zoom - 1e-3) : w;
    this.h = h === 'auto' ? Math.ceil(content.getBoundingClientRect().height / this.zoom - 1e-3) : h;
    Object.assign(content.style, { width: `${this.w}px`, height: `${this.h}px` });
    Object.assign(this.el.style, { width: `${this.w + 2 * pad}px`, height: `${this.h + 2 * pad}px` });
    this.dirty = true;
    this.gpu = null;
  }
  /**
   * Whether the layer must be captured at film time t: always when live; for a [t0, t1] window, inside it, and once
   * whenever t falls on a different side of the window than the last capture (the DOM rests in different states
   * before and after, and frames can be rendered in any order).
   */
  needsCapture(t) {
    if (this.dirty || this.live === true) return true;
    if (!Array.isArray(this.live)) return false;
    const side = (x) => (x < this.live[0] - 1e-6 ? -1 : x > this.live[1] + 1e-6 ? 1 : 0);
    return side(t) === 0 || side(t) !== side(this.capturedAt);
  }
  /** World size of the whole texture (content plus padding) at node scale 1. */
  get worldW() { return this.w + 2 * this.pad; }
  get worldH() { return this.h + 2 * this.pad; }
  /** Marks a static layer for re-capture on the next frame (its DOM changed). */
  invalidate() { this.dirty = true; }
  /** The page's scale changed: the layer zoomed to keep its res (its layout and its texture's size stay as they are), and
   *  captured again. */
  rescale() { this.zoom = this.res / (window.devicePixelRatio || 1); this.el.style.zoom = String(this.zoom); this.dirty = true; }
  /**
   * Before a capture at t: outside its live window a layer is captured with its CSS animations held at one moment (the
   * window's nearest edge; a static layer's at rest), so the capture is the same whichever frame needed it first.
   */
  hold(t) {
    if (this.live === true) return;
    if (!Array.isArray(this.live)) return rest(this.el);
    const [t0, t1] = this.live;
    if (t < t0 || t > t1) pin(t < t0 ? t0 : t1, this.el);
  }

  /** A scene node drawing this layer with its content centre at world (x, y, z). lit: lit by the scene as a matte
   *  surface is (the environment, its lights and their traced shadows: a poster, a sign; receive: false keeps the
   *  shadows off it); bright past 1: its picture is light (a screen glowing); a layer otherwise shows as authored, as UI
   *  does. Every layer in the world shadows the lights that trace their shadows, by its see-through parts. z can also
   *  come third, as a mesh's does: at(x, y, z, o). */
  at(x, y, o = {}, o2 = {}) {
    if (typeof o === 'number') o = { ...o2, z: o };
    // (a value given as a motion is its value now, and the node remembers it: the editor shows its lanes)
    const from = motionsUsed() ? {} : null;
    if (from) { ({ x, y } = settle({ x, y }, from)); o = settle(o, from); }
    const s = o.s ?? 1;
    return { tex: this.gpu, layer: this, x, y, z: o.z ?? 0, w: this.worldW * s, h: this.worldH * s, rx: o.rx, ry: o.ry, rz: o.rz, opacity: o.opacity, blur: o.blur, bright: o.bright, screen: o.screen, receive: o.receive, lit: o.lit, ...(from && Object.keys(from).length && { [STACKS]: from }), ...placed(this) };
  }
  /** Rect (layout px, relative to the content's top-left) of an element inside the content. */
  local(sel) {
    const e = typeof sel === 'string' ? this.content.querySelector(sel) : sel;
    if (!e) return null;
    const c = this.content.getBoundingClientRect(), r = e.getBoundingClientRect();
    return { x: (r.left - c.left) / this.zoom, y: (r.top - c.top) / this.zoom, w: r.width / this.zoom, h: r.height / this.zoom };
  }
  /** World rect of an element inside the content, for a node placed with at(x, y) at scale s (unrotated). */
  world(sel, x, y, s = 1) {
    const r = this.local(sel);
    return r && { x: x + (r.x - this.w / 2) * s, y: y + (r.y - this.h / 2) * s, w: r.w * s, h: r.h * s };
  }
}

/**
 * Resolves once every image in the layers has loaded, as fonts must have: an image still arriving when the film
 * measures its layout, or when a worker first captures its layer, would show or not depending on timing. Lazy images
 * load now (nothing here scrolls into view). Not decode(): a decoded copy kept by some workers and not others draws
 * the image a level differently.
 */
export function imagesReady(host) {
  return Promise.all([...host.canvas.querySelectorAll('img')].map((im) => {
    im.loading = 'eager';
    return im.complete ? null : new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); });
  }));
}

/** Captures every layer that needs it at film time t (live, or dirty static) and rebuilds its mips. Call after nextPaint(). */
export function captureLayers(dev, comp, layers, t) {
  const q = dev.queue;
  for (const L of layers) {
    if (!L.needsCapture(t)) continue;
    if (!L.gpu) {
      const r = L.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      L.gpu = comp.allocLayer(Math.ceil(r.width * dpr - 1e-3), Math.ceil(r.height * dpr - 1e-3));
    }
    q.copyElementImageToTexture({ source: L.el }, { destination: { texture: L.gpu.capture } });
    comp.buildMips(L.gpu);
    L.dirty = false;
    L.capturedAt = t;
  }
}
