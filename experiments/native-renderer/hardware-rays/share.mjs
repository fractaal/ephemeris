// How much of a real frame is walking the hierarchies? The real renderer, its rays walked twice: what the frame gains is what one walk costs.
// share.mjs <film page> <t> <samples> [rendering json]
import { openBrowser } from '../../../tools/browser.mjs';
const [,, page, tArg, subArg, rendering] = process.argv, t = +tArg, sub = +subArg;
const url = page + (rendering ? `?rendering=${encodeURIComponent(rendering)}` : '');
const run = async (label, patch) => {
  const br = await openBrowser(); const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 300000 });
  const r = await p.evaluate(async ([t, sub, patch]) => {
    if (window.__bootError) return { error: window.__bootError };
    const { comp } = window.__ephemeris, L = comp.lib;
    const times = (name, sig, ret, n) => { const before = L.TRACE; const calls = Array.from({ length: n - 1 }, (_, i) => `let w${i} = ${name}0(P, D, tmin * ${(1 + (i + 1) * 1e-7).toFixed(7)}, tmax);`).join(' '); L.TRACE = L.TRACE.replace(sig + ' {', sig + ` { ${calls} let wz = ${name}0(P, D, tmin, tmax); ${ret(n - 1)} }\n` + sig.replace(name, name + '0') + ' {'); return L.TRACE !== before; };
    if (patch.closest > 1 && !times('traceScene', 'fn traceScene(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit', (n) => `var t = wz.t; ${Array.from({ length: n }, (_, i) => `t = min(t, max(w${i}.t, wz.t));`).join(' ')} return RayHit(t, wz.item, wz.prim, wz.b);`, patch.closest)) return { error: 'traceScene not found' };
    if (patch.any > 1 && !times('rayBlocked', 'fn rayBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32', (n) => `var r = wz; ${Array.from({ length: n }, (_, i) => `r = max(r, min(w${i}, wz));`).join(' ')} return r;`, patch.any)) return { error: 'rayBlocked not found' };
    const frames = [];
    for (let i = 0; i < 9; i++) { const out = await window.__frame(t, sub, 0.5, 24, 1, undefined, 'accurate', 0, true); frames.push(out[2]); }
    return { frames };
  }, [t, sub, patch]);
  await br.close();
  if (r.error) { console.log(label, 'ERROR', r.error); return null; }
  const after = r.frames.slice(3), by = {}, med = (v) => v.sort((a, b) => a - b)[v.length >> 1];
  for (const f of after) { for (const x of f.gpu?.passes ?? []) { (by[x.name] ??= []).push(x.ms); for (const q of x.parts ?? []) if (q.name !== x.name) (by['  ' + q.name] ??= []).push(q.ms); } (by['GPU busy'] ??= []).push(f.gpu?.busy ?? 0); (by['GPU first to last'] ??= []).push(f.gpu?.ms ?? 0); for (const x of f.stages ?? []) (by['~' + x.name] ??= []).push(x.ms); (by.__total ??= []).push(f.ms ?? 0); }
  const o = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +med(v).toFixed(1)]));
  return o;
};
const V = [['as is', {}], ['nearest x2', { closest: 2 }], ['nearest x3', { closest: 3 }], ['shadow x2', { any: 2 }], ['shadow x3', { any: 3 }]], R = [];
for (const [l, p] of V) { const o = await run(l, p); if (!o) process.exit(1); R.push(o); }
const keys = [...new Set(R.flatMap((o) => Object.keys(o)))].filter((k) => (R[0][k] ?? 0) >= 2 || R.some((o) => (o[k] ?? 0) >= 5));
console.log('stage'.padEnd(26) + V.map(([l]) => l.padStart(12)).join(''));
for (const k of keys) console.log(k.padEnd(26) + R.map((o) => String(o[k] ?? '-').padStart(12)).join(''));
process.exit(0);
