// Bounded, sequential matrix. Never render two benchmark cases concurrently on one GPU.
// node matrix.mjs <frozen workspace> <webgpu package> <new results directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const [root, dawn, destination] = process.argv.slice(2);
if (!root || !dawn || !destination) throw new Error('Use matrix.mjs <frozen workspace> <webgpu package> <new results directory>');
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.resolve(destination);
await fs.mkdir(out); // Results from an earlier matrix must not be overwritten.
const films = [{ film: 'motion-design-test-claude-2', name: 'dom', times: '18,34', full: '18' }, { film: 'doctor-who-intro-max', name: 'doctor', times: '10,30,55', full: '30' }];
const jobs = [];
for (let repeat = 1; repeat <= 2; repeat++) for (const film of films) {
  const modes = repeat === 1 ? ['baseline', 'compare', 'hybrid'] : ['hybrid', 'compare', 'baseline'];
  for (const mode of modes) jobs.push({ ...film, mode, scale: 0.5, repeat, frames: 24 });
}
for (const film of films) for (const mode of ['baseline', 'compare', 'hybrid']) jobs.push({ ...film, times: film.full, mode, scale: 1, repeat: 1, frames: 12 });
// The first full-resolution HTML measurement was near break-even. Retain its two follow-up
// repetitions in the reproducible matrix instead of treating that small initial gain as reliable.
for (let repeat = 2; repeat <= 3; repeat++) for (const mode of repeat === 2 ? ['hybrid', 'compare', 'baseline'] : ['baseline', 'compare', 'hybrid']) {
  jobs.push({ ...films[0], times: films[0].full, mode, scale: 1, repeat, frames: 12 });
}
await fs.writeFile(path.join(out, 'matrix.json'), JSON.stringify({ root, dawn, jobs }, null, 2));
for (const job of jobs) {
  const name = `${job.name}-${job.scale === 1 ? 'full' : 'half'}-${job.mode}-${job.repeat}`;
  const args = [path.join(here, 'run.mjs'), '--root', root, '--dawn', dawn, '--film', job.film, '--mode', job.mode,
    '--times', job.times, '--scale', String(job.scale), '--samples', '4', '--warm', '6', '--frames', String(job.frames), '--out', path.join(out, name)];
  const log = await fs.open(path.join(out, `${name}.log`), 'w');
  console.log(JSON.stringify({ event: 'start', name, at: new Date().toISOString() }));
  const child = spawn(process.execPath, args, { stdio: ['ignore', log.fd, log.fd] });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  await log.close();
  if (status.code !== 0) throw new Error(`${name} failed (${JSON.stringify(status)}); inspect ${out}/${name}.log`);
  const result = JSON.parse(await fs.readFile(path.join(out, name, 'results.json'), 'utf8'));
  console.log(JSON.stringify({ event: 'complete', name, rows: result.rows.map((r) => ({ t: r.t, fps: r.fps, browser: r.browser?.median, native: r.native?.median })) }));
}
console.log(`Matrix complete: ${out}`);
