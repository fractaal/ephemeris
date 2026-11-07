// What drawing a frame took (engine/render/profile.js), as text: for an agent (the MCP server's profile tool, the
// studio drawing the frame as the editor has the film) and the command line, which draws it in a worker of its own:
//
//   node tools/profile.mjs --url <film page> --t <s> [--fps 60] [--shutter 0.5] [--samples 4] [--scale 1]
//
// (./ephemeris profile <name> [t] [--master] gives these from the timeline.) A worker's first frame compiles its shaders
// and builds the scene's data, so the frame is drawn once and then timed.
import { fileURLToPath } from 'node:url';
import { openWorker } from './worker.mjs';

const ms = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** A frame's profile ({ t, samples, size, ms, stages, gpu }: api/profile's) as lines of text, the GPU's passes slowest first. */
export function describeProfile(p) {
  const subs = `${p.subs} sub-frame${p.subs === 1 ? '' : 's'}${p.samples && p.samples !== p.subs ? ` (${p.samples} asked: more for depth of field or a fast camera)` : ''}`;
  const out = [`At ${(+p.t).toFixed(3)} s${p.size ? `, ${p.size[0]} × ${p.size[1]} px` : ''}, ${subs}: ${ms(p.ms)} ms`, 'The page:'];
  for (const s of p.stages) out.push(`  ${s.name.padEnd(22)}${ms(s.ms).padStart(7)} ms${s.n > 1 ? `  (${s.n} times, ${ms(s.ms / s.n)} each)` : ''}`);
  for (const s of p.said ?? []) out.push(`  ${s.name}: ${s.text}`);
  if (!p.gpu) out.push('The GPU: its passes are not timed on this device.');
  else {
    out.push(`The GPU: ${ms(p.gpu.ms)} ms from its first pass to its last, ${ms(p.gpu.busy)} of it in passes${p.gpu.full ? ' (not every pass timed: there were too many)' : ''}`);
    for (const x of [...p.gpu.passes].sort((a, b) => b.ms - a.ms)) {
      const parts = x.parts.filter((q) => q.name !== x.name).sort((a, b) => b.ms - a.ms);
      out.push(`  ${x.name.padEnd(22)}${ms(x.ms).padStart(7)} ms${parts.length ? `  ${parts.map((q) => `${q.name} ${ms(q.ms)}`).join(' · ')}` : ''}`);
    }
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
  if (!args.url) { console.error('usage: node tools/profile.mjs --url <film page> --t <s> [--fps 60] [--shutter 0.5] [--samples 4] [--scale 1]'); process.exit(2); }
  const t = +(args.t ?? 0), o = { sub: +(args.samples ?? 4), shutter: +(args.shutter ?? 0.5), fps: +(args.fps ?? 60), scale: +(args.scale ?? 1) };
  const w = await openWorker(args.url);
  try {
    const first = Date.now();
    await w.frame(t, o);
    console.log(`(its first draw, its shaders compiled and the scene's data built: ${Date.now() - first} ms)`);
    const fr = await w.frame(t, { ...o, profile: true });
    console.log(describeProfile({ t, samples: o.sub, size: [fr.w, fr.h], ...fr.profile }));
  } finally { await w.close(); }
}
