// Served instead of render/index.js ONLY in the benchmark's HTML-producing page.
// The production runtime still chooses the exact scene times, cuts, overrides, jitter and samples.
// Keep only the browser's layer capture textures: no frame graph, shader pipelines, or 3D buffers.
import { W, H } from '/engine/camera.js';
const prof = () => ({ at() {}, add() {}, subs() {}, time(_name, fn) { return fn(); }, cancel() {} });
export class Renderer {
  constructor(dev, options) { this.dev = dev; this.options = options; this.prof = prof(); this.resize(1); }
  resize(scale = 1) {
    this.pw = Math.max(64, Math.min(W, Math.round(W * scale / 64) * 64));
    this.ph = Math.round(this.pw * H / W); this.rs = this.pw / W;
  }
  allocLayer(w, h) {
    const U = GPUTextureUsage;
    return { w, h, width: w, height: h, version: 0,
      capture: this.dev.createTexture({ size: [w, h], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST | U.RENDER_ATTACHMENT }) };
  }
  buildMips(L) { L.version++; } // the native consumer builds the identical mips after importing the capture
  renderSub() { throw new Error('Install the benchmark recorder before requesting frames'); }
  finish() { throw new Error('Install the benchmark recorder before requesting frames'); }
}
