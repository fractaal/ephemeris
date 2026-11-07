// The shadows the scene's lights cast on what the camera sees: for each pixel the prepass found a surface at, its rays'
// estimate of the shadowed lights' diffuse light there, as if nothing were in the way and through what is (each colour),
// into 'shadow', which the opaque pass shades with and gives the denoiser. Its rays and its estimate are gather's for
// diffuse light (diffuseThrough, shaders.js: Heitz, Hill and McGuire 2018's ratio estimator), taken in a pass of their
// own because a GPU walks rays through the scene's hierarchy several times faster in a small shader than inside the
// opaque pass's whole one (a meadow of 25,000 copies: about 10× on a desktop GPU, 2.5× on an integrated one). What it does not know is the surface's material, so each light and each ray is
// weighed by its light on a white matte surface (see diffuseThrough). Highlights share what it finds where one light has
// shadows at a point (gather); their rays along the surface's own reflection, and toward lights where several have
// shadows, are still taken in the opaque pass, as are those of what reflections and glass meet.
//
// Without it (a film's render.passes leaving it out) the opaque pass takes the diffuse light's rays itself. A film may
// take it (./ephemeris take <film> shadows) and change how its shadows are found. It runs in the frame's bands of rows
// (R.bands), each sent on its own, as the opaque pass does.
const BANDS = 16;   // (R.bands' most)

export const shadows = {
  name: 'shadows', stage: 'sub', reads: ['position', 'normal'], writes: ['shadow'],
  setup(R) {
    const CS = GPUShaderStage.COMPUTE;
    this.layout = R.dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: CS, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: CS, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba32uint' } },
      { binding: 3, visibility: CS, buffer: { hasDynamicOffset: true } }] });
    // (each band's rows, 256 bytes apart: the bind group's offset picks one)
    this.rows = R.dev.createBuffer({ size: 256 * BANDS, label: 'shadow bands', usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  },
  pipe(R) { return R.pipeline(`shadows|${R.surfaceKey}`, () => this.desc(R), true); },
  desc(R) {
    const mod = R.module(R.prelude() + /* wgsl */`
@group(2) @binding(0) var posT: texture_2d<f32>;
@group(2) @binding(1) var nrmT: texture_2d<f32>;
@group(2) @binding(2) var shadowOut: texture_storage_2d<rgba32uint, write>;
@group(2) @binding(3) var<uniform> rows: vec4u;   // the band's first row, and the row after its last
@compute @workgroup_size(8, 8) fn shadows(@builtin(global_invocation_id) id: vec3u) {
  let px = vec2u(id.x, rows.x + id.y);
  if (f32(px.x) >= cam.drawn.x || px.y >= rows.y) { return; }
  let P = textureLoad(posT, px, 0);
  if (P.w < 0.5) { return; }
  // (the pixel's centre, as the opaque pass's fragment has it, so that its rays are the ones gather would take)
  textureStore(shadowOut, px, diffuseThrough(P.xyz, normalize(textureLoad(nrmT, px, 0).xyz), vec2f(px) + 0.5));
}`, 'shadows');
    return { layout: R.pipelineLayout([R.layouts.frame, R.layouts.scene, this.layout]), compute: { module: mod, entryPoint: 'shadows' } };
  },
  want(R, sub) { if (sub.shadowed && sub.solids.length) this.pipe(R); },
  async run(R, sub) {
    if (!sub.shadowed || !sub.solids.length) return;
    const p = await this.pipe(R), bands = Math.min(R.bands, BANDS);
    if (this.gen !== R.tex.gen) {
      this.gen = R.tex.gen;
      this.bg = R.dev.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: R.view('position') }, { binding: 1, resource: R.view('normal') },
        { binding: 2, resource: R.view('shadow') }, { binding: 3, resource: { buffer: this.rows, size: 16 } }] });
    }
    // (the bands' rows as R.band has them)
    const rows = new Uint32Array(64 * bands);
    for (let b = 0; b < bands; b++) { rows[b * 64] = Math.floor((b * R.ph) / bands); rows[b * 64 + 1] = Math.floor(((b + 1) * R.ph) / bands); }
    R.dev.queue.writeBuffer(this.rows, 0, rows);
    for (let b = 0; b < bands; b++) {
      const c = R.enc.beginComputePass({ label: 'shadows' });
      c.setPipeline(p); c.setBindGroup(0, R.frameBG); c.setBindGroup(1, R.sceneBG); c.setBindGroup(2, this.bg, [b * 256]);
      c.dispatchWorkgroups(Math.ceil(R.pw / 8), Math.ceil((rows[b * 64 + 1] - rows[b * 64]) / 8));
      c.end();
      if (bands > 1) R.cut();
    }
    sub.shadowsFound = true;
  },
};
