// The frame as a list of passes. Each pass names the frame's textures it reads and writes; a frame's passes are put in
// order once (assemble) and checked then: a pass that reads what no pass before it writes is an error that names both,
// so a film's own pass, or one it took from the studio and changed, fails when the frame is put together rather than
// drawing something quietly wrong.
//
// A pass: { name, stage: 'sub' (each sub-frame: what the camera sees) or 'frame' (once a frame, on what the sub-frames
// added up), reads: [names], writes: [names], setup(R) (once: its pipelines), run(R, sub) (its draws, into R.enc) }.

/**
 * The frame's textures, by name: their format and the share of the frame's size (as drawn) they are. What each holds:
 *   depth      what is opaque, nearest (reversed: 1 near, 0 far)
 *   position   where the opaque surface at each pixel is (world px; w 1 where there is one)
 *   normal     which way it faces (unit)
 *   ao         how open it is around it (1: wholly; ambient occlusion)
 *   shadow     the shadowed lights' diffuse light the shadows pass found reaching it, as if nothing were in the way
 *              and through what is (each colour, half floats in pairs: see passes/shadows.js, shaders.js diffuseThrough)
 *   gi         the light around it that global illumination found (w 1 where it did)
 *   color      what is opaque, as light (linear, scene-referred)
 *   kept       what the opaque pass keeps for the denoiser at each mesh pixel (three layers: see passes/denoise.js)
 *   light      the frame's light, added up over its sub-frames where no layer as authored covers it (rgb: light × that
 *              share, w: the share)
 *   authored   the layers as authored over it, added up (premultiplied, display-referred sRGB)
 *   glow       the light spread by the lens (bloom)
 *   display    the frame as seen (display-referred sRGB, 0–1)
 */
export const TEXTURES = {
  depth: { format: 'depth32float' },
  position: { format: 'rgba32float' },
  normal: { format: 'rgba16float' },
  ao: { format: 'r16float' },
  shadow: { format: 'rgba32uint', storage: true },
  gi: { format: 'rgba16float', storage: true },
  color: { format: 'rgba16float' },
  kept: { format: 'rgba32uint', layers: 3 },
  light: { format: 'rgba16float' },
  authored: { format: 'rgba16float' },
  glow: { format: 'rgba16float' },
  display: { format: 'rgba16float' },
};

/** The passes in order, checked: each reads only what one before it in its stage (or the sub-frames, for a frame pass) writes. */
export function assemble(passes) {
  const seen = { sub: new Set(), frame: new Set() };
  for (const p of passes) {
    if (!p?.name || !['sub', 'frame'].includes(p.stage)) throw new Error(`a pass is { name, stage: 'sub' | 'frame', reads, writes, setup, run } (${JSON.stringify(p?.name)})`);
    for (const r of p.reads ?? []) {
      if (!(r in TEXTURES) && r !== 'fragments') throw new Error(`pass "${p.name}" reads "${r}", which is not one of the frame's textures (${Object.keys(TEXTURES).join(', ')}, fragments)`);
      if (!seen[p.stage].has(r) && !(p.stage === 'frame' && seen.sub.has(r))) throw new Error(`pass "${p.name}" reads "${r}", which no pass before it writes`);
    }
    for (const w of p.writes ?? []) seen[p.stage].add(w);
  }
  return passes;
}

/** The frame's textures at the size drawn (made again when it changes). */
export class FrameTextures {
  constructor(dev) { this.dev = dev; this.made = []; }
  resize(pw, ph) {
    for (const t of this.made) t.destroy();
    this.made = [];
    const U = GPUTextureUsage;
    for (const [name, spec] of Object.entries(TEXTURES)) {
      const t = this.dev.createTexture({ size: [pw, ph, spec.layers ?? 1], format: spec.format, label: name,
        usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST | (spec.storage ? U.STORAGE_BINDING : 0) });
      this[name] = t;
      this.made.push(t);
    }
    this.gen = (this.gen ?? 0) + 1;
  }
}
