import sys
p=sys.argv[1]; s=open(p).read()
for a,b in [("gpu = create(['backend=vulkan']);","gpu = create(['backend=vulkan', 'enable-dawn-features=allow_unsafe_apis']);"),
 ("requiredFeatures: ['timestamp-query']","requiredFeatures: ['timestamp-query', ...(process.env.EPH_RAYS === '1' ? ['acceleration-structure'] : [])]"),
 ("return { renderMs, profile: took, width: R.pw, height: R.ph, bands: R.bands,","return { rays: R.rays?.built, renderMs, profile: took, width: R.pw, height: R.ph, bands: R.bands,"),
 ("      else if (m.command === 'draw') result = await draw(m.key, m.options);","""      else if (m.command === 'draw') result = await draw(m.key, m.options);
      else if (m.command === 'tlas') {
        const js = [], all = [], { meshes, inst } = R.sub;
        for (let i = 0; i < 9; i++) { R.rays.last = null; const t0 = performance.now(); R.rays.sync(R, meshes, inst); const t1 = performance.now(); await dev.queue.onSubmittedWorkDone(); js.push(t1 - t0); all.push(performance.now() - t0); }
        const med = (x) => [...x].sort((a, b) => a - b)[x.length >> 1];
        result = { instances: R.tlas.items.length / 4, jsMs: med(js), totalMs: med(all), models: R.rays.models.size, boxes: R.rays.boxes.size };
      }""")]:
    assert a in s, a; s=s.replace(a,b)
open(p,'w').write(s)
