// real.mjs <port> <film> <t> <hw|walk> [frames] [out.rgba]: a real frame in a real browser, drawn as the studio's workers
// draw it (tools/browser.mjs, window.__frame, 1080p, 4 sub-frames). walk: the same browser with the feature not asked for.
import fs from 'node:fs'; import path from 'node:path';
const { openBrowser } = await import(path.join(process.env.TREE, 'tools/browser.mjs'));
const [,, port, film, tArg, arm, framesArg = '9', out] = process.argv, t = +tArg, frames = +framesArg;
// (the film as the studio opens it: its timeline's settings in the page's address, its own shutter and rate)
const { filmPage, samplesOf } = await import(path.join(process.env.TREE, 'nle/model.js'));
const dir = path.join(process.env.TREE, 'projects', film, 'timelines'), id = process.env.TIMELINE ?? (fs.existsSync(path.join(dir, 'main.json')) ? 'main' : fs.readdirSync(dir)[0].replace(/\.json$/, ''));
const tl = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')), fps = tl.fps ?? 60, shutter = (tl.shutter ?? 180) / 360, subs = +(process.env.SUBS ?? samplesOf(tl).viewer);
const br = await openBrowser(), p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
let started = false;
p.on('pageerror', (e) => { console.log('[page]', e.message.slice(0, 300)); if (!started) process.exit(3); });   // (a film that cannot load, as some old ones cannot: no waiting for it)
p.on('console', (m) => { if (m.type() === 'error' || /GPU|WGSL|rays/i.test(m.text())) console.log('[console]', m.text().slice(0, 300)); });
if (arm === 'walk') await p.addInitScript(() => {
  const ask = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (d = {}) { return ask.call(this, { ...d, requiredFeatures: [...(d.requiredFeatures ?? [])].filter((f) => f !== 'acceleration-structure') }); };
});
const t0 = Date.now();
await p.goto(filmPage(tl, `http://127.0.0.1:${port}/projects/${film}/`, id), { waitUntil: 'load' });
await p.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 300000 });
const boot = await p.evaluate(() => window.__bootError ?? null); if (boot) throw new Error(boot);
started = true;
const ready = Date.now() - t0;
const state = await p.evaluate(async () => {
  const E = window.__ephemeris, a = await navigator.gpu.requestAdapter();
  return { adapter: a.info.description || a.info.vendor, offered: a.features.has('acceleration-structure'), device: E.dev.features.has('acceleration-structure'), rays: !!E.comp.rays };
});
const r = await p.evaluate(async ([t, frames, move, subs, shutter, fps]) => {
  const ms = [], E = window.__ephemeris, layers = [], busy = []; let took = null;
  // (MOVE: each frame the next moment, so that what changes is drawn again, HTML layers among it)
  for (let i = 0; i < frames; i++) { const t0 = performance.now(); const x = await window.__frame(move ? t + i / fps : t, subs, shutter, fps, 1, undefined, 'accurate', 0, true); ms.push(performance.now() - t0); took = x[2] ?? took; layers.push(took?.stages?.find((s) => s.name === 'Layers')?.ms ?? 0); busy.push(took?.gpu?.busy ?? 0); }
  return { ms, took, layers, busy, built: E.comp.rays?.built ?? null };
}, [t, frames, !!process.env.MOVE, subs, shutter, fps]);
const px = await p.evaluate(async () => {
  const b = window.__last, d = await crypto.subtle.digest('SHA-256', b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b);
  return { size: b.byteLength ?? b.size, sha: [...new Uint8Array(d)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('') };
});
if (out) {
  const s = await p.evaluate(() => { const b = new Uint8Array(window.__last.buffer ?? window.__last, window.__last.byteOffset ?? 0, window.__last.byteLength); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); });
  fs.writeFileSync(out, Buffer.from(s, 'base64'));
}
const rest = r.ms.slice(1).sort((a, b) => a - b), median = rest[rest.length >> 1];
const med = (x) => { const y = x.slice(1).sort((a, b) => a - b); return +(y[y.length >> 1] ?? 0).toFixed(1); };
const brief = (o) => o && { ms: o.ms, stages: o.stages?.map((s) => `${s.name} ${s.ms}`), gpu: o.gpu?.busy, passes: o.gpu?.passes?.filter((x) => x.ms > 1).map((x) => `${x.name} ${x.ms.toFixed(1)}`) };
console.log(JSON.stringify({ film, t, arm, subs, shutter, settings: { gi: tl.gi, rendering: tl.rendering, shadows: tl.shadows }, electron: process.env.ELECTRON_OVERRIDE_DIST_PATH ? 'custom' : 'stock', ...state, readyMs: ready, firstMs: Math.round(r.ms[0]), median: +median?.toFixed(1), gpuBusy: med(r.busy), layersMs: med(r.layers), frames: r.ms.map(Math.round), built: r.built, pixels: px, profile: brief(r.took) }));
await br.close(); process.exit(0);
