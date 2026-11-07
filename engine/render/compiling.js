// Which shaders the GPU is compiling, for whoever is waiting on them to see. A device makes its pipelines one at a time
// in the order they are asked for, and everything sent after one waits for it; work submitted after each says when it
// is made. One is being compiled from when the GPU's work sent before it is done until it is made: before that nothing
// waits on it, the device making it meanwhile, and one its caches hold is made by then (a page loaded again: about 40 of
// spring-brutalist's, none of them said). Watches a device's pipelines from its creation on.
const name = (d) => {
  if (d.label) return d.label;
  const stage = d.compute ?? d.fragment ?? d.vertex, shader = stage?.module?.label || 'a shader', entry = stage?.entryPoint;
  return entry && !['main', 'fs', 'vs'].includes(entry) ? `${shader} · ${entry}` : shader;
};

/**
 * Compiling on `dev` from now on. to(tell): tell({ now, done, total }) as that changes, at most about ten times a second:
 * now, the pipeline being compiled (null: none, the last word of a run of them, or the device still drawing what came
 * before it); done of total, how far along this run.
 */
export function watchCompiling(dev) {
  const going = [];
  let done = 0, total = 0, tell = null, timer = null;
  const say = () => { clearTimeout(timer); timer = null; tell?.({ now: going.find((g) => g.held)?.name ?? null, done, total }); if (!going.length) done = total = 0; };
  const changed = () => { if (!going.length) say(); else timer ??= setTimeout(say, 100); };
  for (const make of ['createRenderPipeline', 'createComputePipeline']) {
    const made = dev[make].bind(dev);
    dev[make] = (d) => {
      const g = { name: name(d), held: false }, before = dev.queue.onSubmittedWorkDone(), p = made(d);
      going.push(g); total++;
      const held = () => { g.held = true; changed(); };
      const over = () => { going.splice(going.indexOf(g), 1); done++; changed(); };
      before.then(held, held);
      dev.queue.onSubmittedWorkDone().then(over, over);
      changed();
      return p;
    };
  }
  // (made away from the GPU process's main thread, side by side: compiling from when it is asked for, unless it is made
  // within 50 ms, as one its caches hold is)
  for (const make of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    if (!dev[make]) continue;
    const made = dev[make].bind(dev);
    dev[make] = (d) => {
      const g = { name: name(d), held: false }, p = made(d);
      going.push(g); total++;
      const soon = setTimeout(() => { g.held = true; changed(); }, 50);
      const over = () => { clearTimeout(soon); going.splice(going.indexOf(g), 1); done++; changed(); };
      p.then(over, over);
      return p;
    };
  }
  dev.lost?.then(() => { going.length = 0; say(); });
  return { to(t) { tell = t; if (going.length) say(); } };
}
