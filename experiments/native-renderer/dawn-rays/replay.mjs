// replay.mjs <file> [frames] [out]: the captured frame on one Dawn build, GI's rays by the walk (off) and by the hardware (on), in turn.
import fs from 'node:fs'; import path from 'node:path'; import { fork } from 'node:child_process';
const [,, file, framesArg, out] = process.argv, frames = +(framesArg ?? 9), TREE = process.env.TREE;
const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')), packet = fs.readFileSync(file);
const arm = (rays) => {
  const c = fork(path.join(TREE, 'experiments/native-renderer/native.mjs'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, EPH_RAYS: rays ? '1' : '0' } });
  let id = 0; const wait = new Map();
  c.on('message', (m) => { const p = wait.get(m.id); wait.delete(m.id); if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m.result); });
  c.on('exit', (code) => { for (const p of wait.values()) p.reject(new Error(`exited ${code}`)); wait.clear(); });
  return { call: (command, x) => new Promise((resolve, reject) => { const i = ++id; wait.set(i, { resolve, reject }); c.send({ id: i, command, ...x }); }), kill: () => c.kill() };
};
const limits = { ...meta.info.limits }; const init = { root: TREE, dawn: process.env.DAWN_PKG, limits, size: meta.info.size, options: meta.options };
process.env.EPH_BRUTE_OFF && (process.env.EPH_BRUTE = '');
const on = arm(true); if (process.env.EPH_BRUTE_OFF) process.env.EPH_BRUTE = '1'; const off = arm(false);
const say = (s) => console.log(s);
const a = await off.call('init', init), b = await on.call('init', init);
say(`devices: off ${a.features.includes('acceleration-structure')}, on ${b.features.includes('acceleration-structure')}; ${b.adapter.description}`);
const stamp = (label, ms) => say(`${label}: ${ms.toFixed(0)} ms`);
const t0 = performance.now(); await off.call('ingest', { packet, key: 'f' }); stamp('ingest off', performance.now() - t0);
const t1 = performance.now(); await on.call('ingest', { packet, key: 'f' }); stamp('ingest on', performance.now() - t1);
const O = { fixedBands: true };
const c0 = performance.now(); await off.call('draw', { key: 'f', options: O }); stamp('first frame off (compiles)', performance.now() - c0);
const c1 = performance.now(); await on.call('draw', { key: 'f', options: O }); stamp('first frame on (compiles)', performance.now() - c1);
for (let i = 0; i < 2; i++) { await off.call('draw', { key: 'f', options: O }); await on.call('draw', { key: 'f', options: O }); }
const A = [], B = [];
for (let i = 0; i < frames; i++) {
  if (i % 2) { B.push((await on.call('draw', { key: 'f', options: O })).renderMs); A.push((await off.call('draw', { key: 'f', options: O })).renderMs); }
  else { A.push((await off.call('draw', { key: 'f', options: O })).renderMs); B.push((await on.call('draw', { key: 'f', options: O })).renderMs); }
}
const med = (x) => [...x].sort((p, q) => p - q)[x.length >> 1];
say(`frame, median of ${frames}: walk ${med(A).toFixed(1)} ms, hardware ${med(B).toFixed(1)} ms (${(med(A) / med(B)).toFixed(2)}×)   [walk ${A.map((x) => x.toFixed(0)).join(' ')}] [hardware ${B.map((x) => x.toFixed(0)).join(' ')}]`);
const pa = await off.call('draw', { key: 'f', options: { ...O, profile: true } }), pb = await on.call('draw', { key: 'f', options: { ...O, profile: true } });
const parts = (p) => { const g = p.profile.gpu; return `gpu busy ${g.busy.toFixed(0)} ms: ` + g.passes.filter((x) => x.ms >= 0.5).map((x) => `${x.name} ${x.ms.toFixed(1)}` + (x.name === 'gi' ? ` (${x.parts.map((y) => `${y.name.replace('gi ', '')} ${y.ms.toFixed(1)}`).join(', ')})` : '')).join(', ') + `; scene data ${p.profile.stages[0].ms.toFixed(0)}`; };
say(`walk:     ${parts(pa)}`); say(`hardware: ${parts(pb)}`); say(`structures built: ${JSON.stringify(pb.rays)}`);
if (process.env.RAYDIFF) { const r = await on.call('raydiff', {}); say(`rays differ: ${r.differ} of ${r.total}, by kind ${JSON.stringify(r.byKind)}`); say(JSON.stringify(r.meshes)); say(`world layers ${r.world}; first items ${JSON.stringify(r.items)}`); for (const x of r.rows) say(JSON.stringify(x)); }
if (process.env.TLAS) say(`top structure built again: ${JSON.stringify(await on.call('tlas', {}))}`);
const ia = await off.call('draw', { key: 'f', options: { ...O, pixels: true } }), ib = await on.call('draw', { key: 'f', options: { ...O, pixels: true } });
const x = ia.pixels, y = ib.pixels; let n = 0, most = 0, sum = 0; const hist = {};
for (let i = 0; i < x.length; i += 4) { const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])); if (d) { n++; sum += d; if (d > most) most = d; const k = d > 16 ? '>16' : d > 8 ? '9-16' : d > 4 ? '5-8' : d > 2 ? '3-4' : String(d); hist[k] = (hist[k] ?? 0) + 1; } }
say(`pictures, walk against hardware: ${n} of ${x.length / 4} pixels differ, most ${most} levels, mean of those ${n ? (sum / n).toFixed(2) : 0}; ${JSON.stringify(hist)}`);
if (out) { fs.writeFileSync(`${out}-walk.rgba`, x); fs.writeFileSync(`${out}-hardware.rgba`, y); fs.writeFileSync(`${out}.size`, `${ia.width}x${ia.height}`); }
on.kill(); off.kill(); process.exit(0);
