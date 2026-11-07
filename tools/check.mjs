// Quality gates for a film, without rendering a video (the scene is a pure function of t, so it is sampled directly):
//  1. camera momentum (--momentum; a warning, for a style that asks for it): inside a shot the camera rests (8 frames
//     under 0.2 px per 1/60 s) or snaps back the way it came;
//  2. padding: no layer's capture has visible pixels on its outer edge (a glow or shadow is being clipped);
//  3. determinism: the same frames rendered twice, in different orders, are byte-identical;
//  4. cursor pacing (--pacing; a warning, for a style that asks for it): a pointer crosses the screen in under 1.5 s;
//  5. cues (warning only): every cue the film reads is in the timeline;
//  6. layers captured once (warning only): none changes, or holds a looping animation, where its capture is reused.
// (Which layer is in front is settled per pixel by depth, so there is no draw order to check.)
//   node tools/check.mjs --url <page> [--momentum] [--pacing] [--graph renders/x-speed.png]   (graph: camera speed per frame)
import { openBrowser } from './browser.mjs';
const flag = (f) => process.argv.includes(`--${f}`);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const br = await openBrowser();
const page = await br.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(args.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 180000 });
let failed = false;
const report = (name, problems, ok, warn = false) => { console.log(problems.length ? `${name}${warn ? ' (warning)' : ''}: ${problems.length} problem(s)\n  ${problems.slice(0, 12).join('\n  ')}${problems.length > 12 ? '\n  …' : ''}` : `${name}: ${ok}`); if (problems.length && !warn) failed = true; };

// 1: sampled at 60 fps
const S = await page.evaluate(() => {
  const { film, lib } = window.__ephemeris, cuts = window.__cuts, N = Math.round(film.duration * 60), [W, H] = window.__size;
  const shot = (t) => cuts.filter((c) => t >= c - 1e-6).length;
  const speed = [], world = [], center = [];
  let prev = null;
  for (let f = 0; f <= N; f++) {
    const t = f / 60, sc = film.scene(t), cam = sc.camera;
    world.push(sc.nodes.some((n) => n && !n.screen && (n.opacity ?? 1) > 0.05));
    const sameShot = prev && shot(prev.t) === shot(t);
    speed.push(sameShot ? lib.screenShift(prev.cam, cam) : null);
    // where the previous frame's screen centre lands now (for reversals)
    if (sameShot) { const p = lib.project(lib.basis(prev.cam).center, lib.basis(cam)); center.push([p.x - W / 2, p.y - H / 2]); } else center.push(null);
    prev = { t, cam };
  }
  return { speed, world, center, cuts, N };
});
const stops = [], reversals = [];
let run = 0;
for (let f = 1; f <= S.N; f++) {
  const v = S.speed[f];
  if (v != null && S.world[f] && v < 0.2) run++; else { if (run >= 8) stops.push(`${((f - run) / 60).toFixed(2)}s–${(f / 60).toFixed(2)}s: camera at rest (under 0.2 px of on-screen motion per 1/60 s)`); run = 0; }
  const a = S.center[f - 1], b = S.center[f];
  if (a && b && Math.hypot(...a) > 2 && Math.hypot(...b) > 2 && a[0] * b[0] + a[1] * b[1] < 0) reversals.push(`${(f / 60).toFixed(2)}s: camera snaps back (the frame was moving ${a.map((x) => x.toFixed(0)).join(', ')} px per 1/60 s, then ${b.map((x) => x.toFixed(0)).join(', ')}: it reverses within a shot)`);
}
if (run >= 8) stops.push(`${((S.N - run) / 60).toFixed(2)}s–end: camera at rest`);
if (flag('momentum')) report('camera momentum', [...stops, ...reversals], 'no rests, no snap-backs', true);

if (args.graph) {
  const W = 1800, H = 300, max = Math.max(4, ...S.speed.filter((v) => v != null).map((v) => Math.min(v, 60)));
  const y = (v) => H - 20 - (Math.log1p(Math.min(v, 60)) / Math.log1p(max)) * (H - 40);
  const pts = S.speed.map((v, f) => (v == null ? null : `${(f / S.N) * W},${y(v)}`));
  const segs = []; let cur = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#111;font:11px monospace">
    ${S.cuts.map((c) => `<line x1="${(c * 60 / S.N) * W}" x2="${(c * 60 / S.N) * W}" y1="0" y2="${H}" stroke="#444"/>`).join('')}
    ${[0.2, 1, 5, 20].map((v) => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#233" /><text x="4" y="${y(v) - 2}" fill="#577">${v} px/f</text>`).join('')}
    ${Array.from({ length: Math.floor(S.N / 60) + 1 }, (_, s) => `<text x="${(s * 60 / S.N) * W + 2}" y="${H - 4}" fill="#666">${s}</text>`).join('')}
    ${segs.map((sg) => `<polyline fill="none" stroke="#d4ff40" stroke-width="1.5" points="${sg.join(' ')}"/>`).join('')}</svg>`;
  await page.setContent(svg); await page.setViewportSize({ width: W, height: H });
  await page.screenshot({ path: args.graph });
  console.log(`speed graph → ${args.graph}`);
  await page.goto(args.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 180000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
}

// 2. padding
const clipped = await page.evaluate(async () => {
  const { dev, layers } = window.__ephemeris;
  await window.__frame(0, 1, 0.5, 60);
  const out = [];
  for (const L of layers) {
    if (!L.gpu || L.fullFrame) continue;   // full-frame screen layers are opaque to the edge by design
    const { w, h, capture } = L.gpu;
    let maxA = 0;
    for (const [ox, oy, cw, ch] of [[0, 0, w, 1], [0, h - 1, w, 1], [0, 0, 1, h], [w - 1, 0, 1, h]]) {
      const bpr = Math.ceil((cw * 4) / 256) * 256;
      const buf = dev.createBuffer({ size: bpr * ch, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = dev.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: capture, origin: [ox, oy, 0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
      dev.queue.submit([enc.finish()]); await buf.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(buf.getMappedRange());
      for (let r = 0; r < ch; r++) for (let x = 0; x < cw; x++) maxA = Math.max(maxA, px[r * bpr + x * 4 + 3]);
      buf.destroy();
    }
    if (maxA > 8) out.push(`${L.label || 'layer'} (edge alpha ${maxA}): increase pad`);
  }
  return out;
});
report('padding', clipped, 'every layer fades out inside its pad');

// 3. determinism
const det = await page.evaluate(async () => {
  const d = window.__duration, ts = [0.1, d * 0.37, d * 0.71, d - 0.1];
  const hash = (px) => { let h = 2166136261; for (let i = 0; i < px.length; i += 7) { h ^= px[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
  const a = []; for (const t of ts) { await window.__frame(t, 2, 0.5, 60); a.push(hash(window.__last)); }
  const b = []; for (const t of [...ts].reverse()) { await window.__frame(t, 2, 0.5, 60); b.unshift(hash(window.__last)); }
  return ts.map((t, i) => [t, a[i] === b[i]]);
});
report('determinism', det.filter(([, ok]) => !ok).map(([t]) => `${t.toFixed(2)}s differs when reached differently`), 'identical frames however they are reached');
// 4. cursor pacing (a warning, not a failure): a pointer that crosses the screen in under 1.5 s reads as frantic. Short
// hops (to a control right beside it) and drags (a selection, made while pressed) are meant to be quick.
const fast = await page.evaluate(() => (window.__ephemeris.cursors ?? []).flatMap((c, i) => c.moves.filter((m) => !m.drag && m.dur < 1.5).map((m) => {
  const a = c.pos(m.t), b = c.pos(m.t + m.dur + 0.2);
  return { i, t: m.t, dur: m.dur, d: Math.hypot(b[0] - a[0], b[1] - a[1]) };
}).filter((m) => m.d > 160)));
if (flag('pacing')) console.log(fast.length ? `cursor pacing (warning): ${fast.length} quick move(s)\n  ${fast.map((m) => `${m.t.toFixed(2)}s: cursor ${m.i} crosses ${Math.round(m.d)} px in ${m.dur.toFixed(2)} s`).join('\n  ')}` : 'cursor pacing: every move across the screen takes 1.5 s or more');
// 5. cues (a warning): every cue the film reads should be in the timeline, or the film quietly uses its fallback
const refs = await page.evaluate(() => window.__cueRefs ?? []), missing = refs.filter((r) => !r.found).map((r) => r.id);
console.log(missing.length ? `cues (warning): the film reads ${missing.length} cue(s) the timeline does not have, and uses its own timing for them: ${missing.join(', ')}` : `cues: the film reads ${refs.length} cue(s), all in the timeline`);
// 6. layers captured once (a warning): a static layer, or a windowed one outside its window, is captured once and that
// capture is reused for every frame there. A DOM change across those frames never shows, and which state does show
// depends on which frame a worker rendered first; a looping animation in it (a spinner) shows frozen.
const once = await page.evaluate(() => {
  const { film, domAt } = window.__ephemeris, N = Math.floor(film.duration * 10);
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const name = (L) => `"${L.label || 'layer'}"`, first = new Map(), out = [], told = new Set(), loops = new Map();
  for (let f = 0; f <= N; f++) {
    const t = f / 10, live = (L) => L.live === true || (Array.isArray(L.live) && t >= L.live[0] && t <= L.live[1]);
    const drawn = [...new Set(film.scene(t).nodes.map((n) => n?.layer))].filter((L) => L?.el && !live(L));
    if (!drawn.length) continue;
    domAt(t);
    for (const L of drawn) {
      const side = !Array.isArray(L.live) ? '' : t < L.live[0] ? ' before its live window' : ' after its live window';
      const seen = first.get(L) ?? {}, k = hash(L.el.innerHTML);
      first.set(L, seen);
      if (!seen[side]) seen[side] = [k, t];
      else if (seen[side][0] !== k && !told.has(L)) { told.add(L); out.push(`${name(L)} changes between ${seen[side][1].toFixed(1)}s and ${t.toFixed(1)}s${side}, where one capture is reused: give it a live window over the change`); }
      if (!loops.has(L) && L.el.getAnimations({ subtree: true }).some((a) => !Number.isFinite(a.effect?.getComputedTiming().endTime))) loops.set(L, t);
    }
  }
  // ambient loops are everywhere in a product's UI, and still is usually fine: one line, for the one that should move
  if (loops.size) out.push(`${loops.size} layer(s) hold looping CSS animations where they are captured once, so those show still (a spinner that does not spin; give the layer a live window there if it should): ${[...loops].map(([L, t]) => `${name(L)} ${t.toFixed(1)}s`).join(', ')}`);
  return out;
});
console.log(once.length ? `layers captured once (warning):\n  ${once.join('\n  ')}` : 'layers captured once: none changes or loops where its capture is reused');
await br.close();
process.exit(failed ? 1 : 0);
