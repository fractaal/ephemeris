// What drawing a frame took, as the studio's profiler shows it: the page's time on each stage of it (the film's code,
// its layers, the scene made ready for the GPU, waiting for the GPU), and the GPU's in each of the renderer's passes,
// from WebGPU's timestamps where the device has them. Off unless a frame asks: then every pass begun on the device is
// timed (the heavy passes' bands, each sent on its own, and those of the layers', the textures' and the geometry's
// encoders too), counted to the renderer's pass running as it began (`at`), and within it to the pass's own label (a
// film's pass by its label, the GI's stages by theirs).

// (timestamps: two a pass, in sets of 4096 made as a frame needs them, up to 16: a doctor-who frame of four sub-frames
// begins some 2300 passes, its bands and mip levels each one; past that, the rest are not timed)
const SET = 4096, SETS = 16;

export function createProfiler(dev) {
  const can = dev.features.has('timestamp-query');
  let on = null;
  const sets = [];   // ({ qs, resolved, read })
  const setOf = (i) => (sets[i] ??= { qs: dev.createQuerySet({ type: 'timestamp', count: SET }),
    resolved: dev.createBuffer({ size: SET * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: dev.createBuffer({ size: SET * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) });
  if (can) {
    const make = dev.createCommandEncoder.bind(dev);
    dev.createCommandEncoder = (d) => {
      const enc = make(d);
      if (on) for (const k of ['beginRenderPass', 'beginComputePass']) {
        const begin = enc[k].bind(enc);
        enc[k] = (desc = {}) => {
          if (!on || desc.timestampWrites || on.n + 2 > SET * SETS) { if (on) on.full ||= on.n + 2 > SET * SETS; return begin(desc); }
          on.spans.push([on.at, desc.label ?? '', on.n]);
          const i = on.n % SET, p = begin({ ...desc, timestampWrites: { querySet: setOf(Math.floor(on.n / SET)).qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } });
          on.n += 2;
          return p;
        };
      }
      return enc;
    };
  }
  const P = {
    /** Whether this frame is being timed. */
    get on() { return !!on; },
    /** Starts timing a frame. */
    begin() { on = { t0: performance.now(), n: 0, spans: [], at: 'other', stages: new Map(), said: new Map(), full: false }; },
    /** Stops timing a frame that will not end (one that failed). */
    cancel() { on = null; },
    /** The renderer's pass whose GPU work follows. */
    at(name) { if (on) on.at = name; },
    /** How many sub-frames the frame is drawn in (more than asked: depth of field, a fast camera). */
    subs(n) { if (on) on.subs = n; },
    /** What a pass says of what it did, in words (the cull pass: how many copies it drew): its last, in the frame's profile. */
    say(name, text) { if (on) on.said.set(name, text); },
    /** Time spent on a stage of the frame, since `t0` (performance.now()): once more. */
    add(stage, t0) { if (!on) return; const s = on.stages.get(stage) ?? { ms: 0, n: 0 }; s.ms += performance.now() - t0; s.n++; on.stages.set(stage, s); },
    /** fn(), its time counted to `stage`. */
    time(stage, fn) {
      if (!on) return fn();
      const t0 = performance.now();
      try { return fn(); } finally { P.add(stage, t0); }
    },
    /** The frame's timestamps read back with its pixels: resolved into its last encoder, before it is sent. */
    resolve(enc) {
      for (let k = 0; on && k * SET < on.n; k++) {
        const n = Math.min(SET, on.n - k * SET), S = sets[k];
        enc.resolveQuerySet(S.qs, 0, n, S.resolved, 0); enc.copyBufferToBuffer(S.resolved, 0, S.read, 0, n * 8);
      }
    },
    /**
     * The frame's profile, once its last work is done: { ms (the whole of it), subs (sub-frames drawn), stages: [{ name,
     * ms, n (times) }], said: [{ name, text }] (what passes said: say), gpu: { ms (its
     * first pass's start to its last's end), busy (of that, in one pass or another), passes: [{ name, ms, parts: [{ name,
     * ms }] }], full (some passes not timed) } or null (no timestamps on this device) }.
     */
    async end() {
      const f = on;
      on = null;
      if (!f) return null;
      let gpu = null;
      if (f.n) {
        const ts = new BigInt64Array(f.n);
        for (let k = 0; k * SET < f.n; k++) {
          const n = Math.min(SET, f.n - k * SET), { read } = sets[k];
          await read.mapAsync(GPUMapMode.READ, 0, n * 8);
          ts.set(new BigInt64Array(read.getMappedRange(0, n * 8)), k * SET);
          read.unmap();
        }
        const passes = new Map(), spans = [];
        for (const [at, label, i] of f.spans) {
          const a = ts[i], b = ts[i + 1];
          if (!(b >= a) || a === 0n) continue;   // (one the GPU did not reach)
          spans.push([a, b]);
          const ms = Number(b - a) / 1e6, p = passes.get(at) ?? { name: at, ms: 0, parts: new Map() };
          p.ms += ms;
          if (label) p.parts.set(label, (p.parts.get(label) ?? 0) + ms);
          passes.set(at, p);
        }
        // (how long it was in one pass or another, from its first's start to its last's end: the rest it waited for work)
        spans.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        let busy = 0n, upto = null;
        for (const [a, b] of spans) { if (upto == null || a >= upto) { busy += b - a; upto = b; } else if (b > upto) { busy += b - upto; upto = b; } }
        const round = (ms) => +ms.toFixed(3), span = spans.length ? Number(upto - spans[0][0]) / 1e6 : 0;
        gpu = { ms: round(span), busy: round(Number(busy) / 1e6), full: f.full,
          passes: [...passes.values()].map((p) => ({ name: p.name, ms: round(p.ms), parts: [...p.parts].map(([name, ms]) => ({ name, ms: round(ms) })) })) };
      }
      return { ms: +(performance.now() - f.t0).toFixed(2), subs: f.subs ?? 1, stages: [...f.stages].map(([name, s]) => ({ name, ms: +s.ms.toFixed(2), n: s.n })), said: [...f.said].map(([name, text]) => ({ name, text })), gpu };
    },
  };
  return P;
}
